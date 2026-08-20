import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import treeSitterJava from 'tree-sitter-java';
import type { CodeNode, CodeEdge, NodeType } from './types.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * Extract the leading JSDoc or single-line comment block immediately above
 * `startLine` (1-based).  Walks backwards through `lines` collecting:
 *   - block comments: /** ... *\/ and /* ... *\/
 *   - consecutive `//` lines
 *
 * Returns the comment text (stripped of delimiters/asterisks) or undefined.
 */
function extractLeadingComment(lines: string[], startLine: number): string | undefined {
  const idx = startLine - 2;  // convert to 0-based, then go one line above
  if (idx < 0) return undefined;

  const above = lines[idx]?.trimEnd() ?? '';

  // ── Block comment ending on the line just above ───────────────────────────
  if (above.trimStart().endsWith('*/')) {
    // Walk back to find the opening /*
    const commentLines: string[] = [];
    for (let i = idx; i >= 0; i--) {
      const l = lines[i] ?? '';
      commentLines.unshift(l);
      if (l.trimStart().startsWith('/*')) break;
    }
    return commentLines
      .join('\n')
      .replace(/\/\*\*?/g, '')
      .replace(/\*\//g, '')
      .replace(/^\s*\*\s?/gm, '')
      .trim() || undefined;
  }

  // ── Consecutive single-line comments ─────────────────────────────────────
  if (above.trimStart().startsWith('//')) {
    const commentLines: string[] = [];
    for (let i = idx; i >= 0; i--) {
      const l = lines[i] ?? '';
      if (!l.trimStart().startsWith('//')) break;
      commentLines.unshift(l.trimStart().replace(/^\/\/\s?/, ''));
    }
    return commentLines.length > 0 ? commentLines.join('\n').trim() : undefined;
  }

  return undefined;
}

function nodeId(filePath: string, type: NodeType, name: string, line: number): string {
  return `${filePath}:${type}:${name}:${line}`;
}

export interface ParseResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tree-sitter parser  (Java)
// ═══════════════════════════════════════════════════════════════════════════════

interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

const javaParser = new Parser() as { setLanguage(l: unknown): void; parse(s: string): { rootNode: SyntaxNode } };
javaParser.setLanguage(treeSitterJava as unknown);

const JAVA_KIND_MAP: Record<string, NodeType> = {
  class_declaration:       'CLASS',
  interface_declaration:   'INTERFACE',
  enum_declaration:        'CLASS',
  record_declaration:      'CLASS',
  method_declaration:      'METHOD',
  constructor_declaration: 'METHOD',
};

function javaQualifiedName(packageName: string, owners: CodeNode[], name: string): string {
  const segments = [...owners.map(owner => owner.name), name].filter(Boolean);
  return [packageName, ...segments].filter(Boolean).join('.');
}

// Extract a configuration constant name from a getConfigurationItem argument node.
function extractConstName(arg: SyntaxNode): string | null {
  if (arg.type === 'member_access') return arg.text;
  if (arg.type === 'identifier' && /^[A-Z][A-Z0-9_]+$/.test(arg.text)) return arg.text;
  return null;
}

function parseJava(relPath: string, source: string): ParseResult {
  const lines       = source.split('\n');
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const tree = javaParser.parse(source);
  const packageNode = tree.rootNode.namedChildren.find(node => node.type === 'package_declaration');
  const packageName = packageNode?.namedChildren[0]?.text ?? '';

  const fileNode: CodeNode = {
    id: nodeId(relPath, 'FILE', relPath, 0), type: 'FILE', name: path.basename(relPath),
    filePath: relPath, startLine: 1, endLine: lines.length, hash: contentHash(source),
    qualifiedName: packageName || relPath, language: 'java',
  };
  nodes.push(fileNode);

  const ownerStack: CodeNode[] = [];
  const callsSeen = new Set<string>();

  function addJavaDeclaration(node: SyntaxNode, parentId: string, kind: NodeType): CodeNode {
    const name = node.childForFieldName('name')?.text ?? '<anonymous>';
    const start = node.startPosition.row + 1;
    const end = node.endPosition.row + 1;
    const owners = kind === 'METHOD' ? ownerStack : ownerStack.slice(0, -1);
    const codeNode: CodeNode = {
      id: nodeId(relPath, kind, name, start), type: kind, name, filePath: relPath,
      startLine: start, endLine: end,
      hash: contentHash(lines.slice(start - 1, end).join('\n')),
      documentation: extractLeadingComment(lines, start),
      qualifiedName: javaQualifiedName(packageName, owners, name), language: 'java',
    };
    nodes.push(codeNode);
    edges.push({ source: parentId, target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
    if (kind !== 'METHOD') {
      edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES', confidence: 1, resolution: 'structural' });
    }
    return codeNode;
  }

  // Emit READS_CONFIG edges for each constant argument of a config-reader call.
  function addConfigEdges(callNode: SyntaxNode, ownerId: string, sourceLine: number): void {
    const args = callNode.childForFieldName('arguments');
    if (!args) return;
    for (const arg of args.namedChildren) {
      const constName = extractConstName(arg);
      if (!constName) continue;
      const constKey = `${ownerId}::config::${constName}`;
      if (callsSeen.has(constKey)) continue;
      callsSeen.add(constKey);
      edges.push({ source: ownerId, target: constName, type: 'READS_CONFIG', confidence: 0.9, resolution: 'ast', sourceLine });
    }
  }

  function addJavaCall(node: SyntaxNode): void {
    const owner = ownerStack.at(-1);
    const callee = node.childForFieldName('name')?.text;
    if (!owner || !callee || callee === owner.name) return;

    const key = `${owner.id}::${callee}`;
    if (callsSeen.has(key)) return;
    callsSeen.add(key);
    edges.push({
      source: owner.id, target: callee, type: 'CALLS', confidence: 0.6,
      resolution: 'ast', sourceLine: node.startPosition.row + 1,
    });

    if (/^getConfiguration(Item)?$|^getConfigItem$/.test(callee)) {
      addConfigEdges(node, owner.id, node.startPosition.row + 1);
    }
  }

  function visit(node: SyntaxNode, parentId: string): void {
    const kind = JAVA_KIND_MAP[node.type];
    if (kind !== undefined) {
      const codeNode = addJavaDeclaration(node, parentId, kind);
      const isOwner = kind === 'CLASS' || kind === 'INTERFACE' || kind === 'METHOD';
      if (isOwner) ownerStack.push(codeNode);
      for (const child of node.namedChildren) visit(child, codeNode.id);
      if (isOwner) ownerStack.pop();
      return;
    }

    if (node.type === 'method_invocation') {
      addJavaCall(node);
    }

    for (const child of node.namedChildren) visit(child, parentId);
  }

  visit(tree.rootNode, fileNode.id);
  return { nodes, edges };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public entry point — Java only
// ═══════════════════════════════════════════════════════════════════════════════

export function parseFile(absPath: string, repoRoot: string): ParseResult {
  if (path.extname(absPath).toLowerCase() !== '.java') return { nodes: [], edges: [] };

  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return { nodes: [], edges: [] };
  }

  const relPath = path.relative(repoRoot, absPath).replaceAll('\\', '/');
  return parseJava(relPath, source);
}

interface LangPattern {
  class?:    RegExp;
  function?: RegExp;
  method?:   RegExp;
  interface?:RegExp;
  import?:   RegExp;
  extends?:  RegExp;   // capture group 1 = child, group 2 = parent
  implements?:RegExp;  // capture group 1 = child, group 2 = iface
}

// Named capture group `name` expected in each pattern
const LANG_PATTERNS: Record<string, LangPattern> = {
  // ── Python ──────────────────────────────────────────────────────────────────
  py: {
    class:    /^class\s+(?<name>\w+)/,
    function: /^(?:async\s+)?def\s+(?<name>\w+)/,
    method:   /^\s{4,}(?:async\s+)?def\s+(?<name>\w+)/,
    import:   /^(?:import\s+(?<name>[\w.]+)|from\s+(?<name2>[\w.]+)\s+import)/,
    extends:  /^class\s+\w+\((?<name>.+?)\)/,
  },
  // ── Java / Kotlin ────────────────────────────────────────────────────────────
  java: {
    class:    /(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*class\s+(?<name>\w+)/,
    interface:/(?:public\s+)?interface\s+(?<name>\w+)/,
    method:   /(?:public|private|protected|static|void|int|long|boolean|String|<\w+>|\[\]|\w+)\s+(?<name>\w+)\s*\([^)]*\)\s*(?:throws\s+\w+\s*)?\{/,
    import:   /^import\s+(?:static\s+)?(?<name>[\w.]+)/,
    extends:  /class\s+\w+\s+extends\s+(?<name>\w+)/,
    implements:/class\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+(?<name>[\w,\s]+)/,
  },
  kt: {
    class:    /(?:data\s+|open\s+|abstract\s+|sealed\s+)?class\s+(?<name>\w+)/,
    interface:/interface\s+(?<name>\w+)/,
    function: /fun\s+(?<name>\w+)\s*\(/,
    import:   /^import\s+(?<name>[\w.]+)/,
  },
  // ── Go ──────────────────────────────────────────────────────────────────────
  go: {
    class:    /^type\s+(?<name>\w+)\s+struct/,
    interface:/^type\s+(?<name>\w+)\s+interface/,
    function: /^func\s+(?<name>\w+)\s*\(/,
    method:   /^func\s+\(\w+\s+\*?\w+\)\s+(?<name>\w+)\s*\(/,
    import:   /"(?<name>[^"]+)"/,
  },
  // ── Rust ────────────────────────────────────────────────────────────────────
  rs: {
    class:    /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(?<name>\w+)/,
    interface:/^(?:pub(?:\([^)]*\))?\s+)?trait\s+(?<name>\w+)/,
    function: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?<name>\w+)/,
    method:   /^\s{4}(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?<name>\w+)/,
    import:   /^use\s+(?<name>[\w:]+)/,
  },
  // ── C# ──────────────────────────────────────────────────────────────────────
  cs: {
    class:    /(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|sealed\s+)*class\s+(?<name>\w+)/,
    interface:/(?:public\s+|internal\s+)?interface\s+(?<name>\w+)/,
    method:   /(?:public|private|protected|internal|static|override|virtual|async)\s+[\w<>[\]]+\s+(?<name>\w+)\s*\(/,
    import:   /^using\s+(?:static\s+)?(?<name>[\w.]+)/,
    extends:  /class\s+\w+\s*:\s*(?<name>[\w,\s]+)/,
  },
  // ── Ruby ────────────────────────────────────────────────────────────────────
  rb: {
    class:    /^\s*(?:module\s+|class\s+)(?<name>\w+)/,
    method:   /^\s*def\s+(?<name>[\w?!]+)/,
    import:   /^\s*(?:require|require_relative)\s+['"](?<name>[^'"]+)['"]/,
    extends:  /class\s+\w+\s*<\s*(?<name>\w+)/,
  },
  // ── PHP ─────────────────────────────────────────────────────────────────────
  php: {
    class:    /(?:abstract\s+|final\s+)?class\s+(?<name>\w+)/,
    interface:/interface\s+(?<name>\w+)/,
    method:   /(?:public|private|protected|static)?\s*function\s+(?<name>\w+)\s*\(/,
    import:   /(?:use|require|include)\s+['"]?(?<name>[\w/\\]+)/,
    extends:  /class\s+\w+\s+extends\s+(?<name>\w+)/,
    implements:/class\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+(?<name>[\w,\s]+)/,
  },
  // ── Swift ────────────────────────────────────────────────────────────────────
  swift: {
    class:    /(?:open\s+|public\s+|private\s+|final\s+)?class\s+(?<name>\w+)/,
    interface:/protocol\s+(?<name>\w+)/,
    function: /func\s+(?<name>\w+)\s*[(<]/,
    import:   /^import\s+(?<name>\w+)/,
  },
  // ── C / C++ ─────────────────────────────────────────────────────────────────
  c: {
    class:    /(?:class|struct)\s+(?<name>\w+)/,
    function: /^[\w*&:<>]+\s+(?<name>\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/,
    import:   /^#include\s+[<"](?<name>[^>"]+)[>"]/,
  },
  // ── Dart ────────────────────────────────────────────────────────────────────
  dart: {
    class:    /(?:abstract\s+)?class\s+(?<name>\w+)/,
    function: /(?:[\w<>?]+\s+)?(?<name>\w+)\s*\([^)]*\)\s*(?:async\s*)?\{/,
    import:   /^import\s+'(?<name>[^']+)'/,
  },
  // ── Shell ───────────────────────────────────────────────────────────────────
  sh: {
    function: /^(?:function\s+)?(?<name>\w+)\s*\(\)/,
  },
};

// Map file extension → pattern key
const EXT_TO_LANG: Record<string, string> = {
  '.py': 'py', '.pyw': 'py',
  '.java': 'java',
  '.kt': 'kt', '.kts': 'kt',
  '.go': 'go',
  '.rs': 'rs',
  '.cs': 'cs',
  '.rb': 'rb',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c', '.cpp': 'c', '.cc': 'c', '.cxx': 'c', '.h': 'c', '.hpp': 'c',
  '.dart': 'dart',
  '.sh': 'sh', '.bash': 'sh',
};

function matchName(line: string, rx: RegExp): string | null {
  const m = rx.exec(line);
  if (!m) return null;
  // support named group `name` or `name2`
  return (m.groups?.['name'] ?? m.groups?.['name2'] ?? null);
}

function parseFallback(relPath: string, source: string): ParseResult {
  const ext  = path.extname(relPath).toLowerCase();
  const lang = EXT_TO_LANG[ext] ?? 'sh';
  const pat  = LANG_PATTERNS[lang] ?? LANG_PATTERNS['sh']!;

  const lines  = source.split('\n');
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];

  const fileNode: CodeNode = {
    id:        nodeId(relPath, 'FILE', relPath, 0),
    type:      'FILE',
    name:      path.basename(relPath),
    filePath:  relPath,
    startLine: 1,
    endLine:   lines.length,
    hash:      contentHash(source),
  };
  nodes.push(fileNode);

  // Track current class context for method→class CONTAINS edges
  let currentClassNode: CodeNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i] ?? '';
    const lineNum = i + 1;

    // CLASS
    if (pat.class) {
      const name = matchName(line, pat.class);
      if (name) {
        const codeNode: CodeNode = {
          id:            nodeId(relPath, 'CLASS', name, lineNum),
          type:          'CLASS',
          name,
          filePath:      relPath,
          startLine:     lineNum,
          endLine:       lineNum,  // fallback: single-line marker
          hash:          contentHash(name + lineNum),
          documentation: extractLeadingComment(lines, lineNum),
        };
        nodes.push(codeNode);
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'CONTAINS' });
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES'  });
        currentClassNode = codeNode;

        // EXTENDS
        if (pat.extends) {
          const parent = matchName(line, pat.extends);
          if (parent) edges.push({ source: codeNode.id, target: parent, type: 'EXTENDS' });
        }
        // IMPLEMENTS
        if (pat.implements) {
          const iface = matchName(line, pat.implements);
          if (iface) edges.push({ source: codeNode.id, target: iface, type: 'IMPLEMENTS' });
        }
        continue;
      }
    }

    // INTERFACE
    if (pat.interface) {
      const name = matchName(line, pat.interface);
      if (name) {
        const codeNode: CodeNode = {
          id:            nodeId(relPath, 'INTERFACE', name, lineNum),
          type:          'INTERFACE',
          name,
          filePath:      relPath,
          startLine:     lineNum,
          endLine:       lineNum,
          hash:          contentHash(name + lineNum),
          documentation: extractLeadingComment(lines, lineNum),
        };
        nodes.push(codeNode);
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'CONTAINS' });
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES'  });
        continue;
      }
    }

    // METHOD (must check before FUNCTION — method patterns are more indented)
    if (pat.method) {
      const name = matchName(line, pat.method);
      if (name) {
        const parent = currentClassNode ?? fileNode;
        const codeNode: CodeNode = {
          id:            nodeId(relPath, 'METHOD', name, lineNum),
          type:          'METHOD',
          name,
          filePath:      relPath,
          startLine:     lineNum,
          endLine:       lineNum,
          hash:          contentHash(name + lineNum),
          documentation: extractLeadingComment(lines, lineNum),
        };
        nodes.push(codeNode);
        edges.push({ source: parent.id,    target: codeNode.id, type: 'CONTAINS' });
        continue;
      }
    }

    // FUNCTION (top-level only — not indented)
    if (pat.function) {
      const name = matchName(line, pat.function);
      if (name) {
        const codeNode: CodeNode = {
          id:            nodeId(relPath, 'FUNCTION', name, lineNum),
          type:          'FUNCTION',
          name,
          filePath:      relPath,
          startLine:     lineNum,
          endLine:       lineNum,
          hash:          contentHash(name + lineNum),
          documentation: extractLeadingComment(lines, lineNum),
        };
        nodes.push(codeNode);
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'CONTAINS' });
        edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES'  });
        continue;
      }
    }

    // IMPORT
    if (pat.import) {
      const target = matchName(line, pat.import);
      if (target) {
        edges.push({ source: fileNode.id, target, type: 'IMPORTS' });
      }
    }
  }

  return { nodes, edges };
}
