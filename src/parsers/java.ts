/**
 * parsers/java.ts
 * ───────────────
 * Java language parser adapter using tree-sitter.
 * Implements LanguageParser — register in registry.ts to activate.
 *
 * Extracts:
 *   Nodes  — FILE, CLASS (incl. enums + records), INTERFACE, METHOD (incl. constructors)
 *   Edges  — CONTAINS, DEFINES (structural, written immediately)
 *   Refs   — EXTENDS, IMPLEMENTS, IMPORTS (name-based, resolved in second pass by Indexer)
 *   Calls  — CALLS, READS_CONFIG (name-based, resolved by Indexer's batchUpsertCallEdges)
 *
 * Design inspired by codegraph's TsParser / two-pass resolution pattern.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import treeSitterJava from 'tree-sitter-java';
import type { CodeNode, CodeEdge, NodeType } from '../types.js';
import type { LanguageParser, ParseResult } from './base.js';
import { emptyParseResult } from './base.js';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function nodeId(filePath: string, type: NodeType, name: string, line: number): string {
  return `${filePath}:${type}:${name}:${line}`;
}

/**
 * Extract the leading JSDoc or single-line comment block immediately above
 * `startLine` (1-based). Collects block comments (/** ... *\/) and consecutive
 * `//` lines. Returns the stripped comment text or undefined.
 */
function extractLeadingComment(lines: string[], startLine: number): string | undefined {
  const idx = startLine - 2;
  if (idx < 0) return undefined;

  const above = lines[idx]?.trimEnd() ?? '';

  if (above.trimStart().endsWith('*/')) {
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

// ── Tree-sitter setup ──────────────────────────────────────────────────────────

interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

const _javaParser = new Parser() as {
  setLanguage(l: unknown): void;
  parse(s: string): { rootNode: SyntaxNode };
};
_javaParser.setLanguage(treeSitterJava as unknown);

const JAVA_KIND_MAP: Record<string, NodeType> = {
  class_declaration:       'CLASS',
  interface_declaration:   'INTERFACE',
  enum_declaration:        'CLASS',
  record_declaration:      'CLASS',
  method_declaration:      'METHOD',
  constructor_declaration: 'METHOD',
};

function javaQualifiedName(packageName: string, owners: CodeNode[], name: string): string {
  const segments = [...owners.map(o => o.name), name].filter(Boolean);
  return [packageName, ...segments].filter(Boolean).join('.');
}

/** Extract a config-constant name from a getConfigurationItem argument. */
function extractConstName(arg: SyntaxNode): string | null {
  if (arg.type === 'member_access') return arg.text;
  if (arg.type === 'identifier' && /^[A-Z][A-Z0-9_]+$/.test(arg.text)) return arg.text;
  return null;
}

// ── JavaParser class ───────────────────────────────────────────────────────────

export class JavaParser implements LanguageParser {
  readonly extensions = ['.java'] as const;

  parse(absPath: string, repoRoot: string): ParseResult {
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch {
      return emptyParseResult();
    }
    const relPath = path.relative(repoRoot, absPath).replaceAll('\\', '/');
    return this._parseSource(relPath, source);
  }

  // ── Internal parsing ─────────────────────────────────────────────────────────

  private _parseSource(relPath: string, source: string): ParseResult {
    const lines       = source.split('\n');
    const result      = emptyParseResult();
    const tree        = _javaParser.parse(source);
    const root        = tree.rootNode;

    // ── Package name ─────────────────────────────────────────────────────────
    const packageDecl = root.namedChildren.find(n => n.type === 'package_declaration');
    const packageName = packageDecl?.namedChildren[0]?.text ?? '';

    // ── File node ────────────────────────────────────────────────────────────
    const fileNode: CodeNode = {
      id:           nodeId(relPath, 'FILE', relPath, 0),
      type:         'FILE',
      name:         path.basename(relPath),
      filePath:     relPath,
      startLine:    1,
      endLine:      lines.length,
      hash:         contentHash(source),
      qualifiedName: packageName || relPath,
      language:     'java',
    };
    result.nodes.push(fileNode);

    // ── Import statements → importRefs (second pass) ─────────────────────────
    for (const child of root.namedChildren) {
      if (child.type === 'import_declaration') {
        // import com.example.Foo; → qualified name is the second named child
        const nameNode = child.namedChildren.find(n =>
          n.type === 'scoped_identifier' || n.type === 'identifier',
        );
        if (nameNode) {
          result.importRefs.push({ sourceId: fileNode.id, targetName: nameNode.text });
        }
      }
    }

    // ── Walk declarations ────────────────────────────────────────────────────
    const ownerStack: CodeNode[] = [];
    const callsSeen   = new Set<string>();

    const addDeclaration = (node: SyntaxNode, parentId: string, kind: NodeType): CodeNode => {
      const name  = node.childForFieldName('name')?.text ?? '<anonymous>';
      const start = node.startPosition.row + 1;
      const end   = node.endPosition.row + 1;
      const owners = kind === 'METHOD' ? ownerStack : ownerStack.slice(0, -1);

      const codeNode: CodeNode = {
        id:           nodeId(relPath, kind, name, start),
        type:         kind,
        name,
        filePath:     relPath,
        startLine:    start,
        endLine:      end,
        hash:         contentHash(lines.slice(start - 1, end).join('\n')),
        documentation: extractLeadingComment(lines, start),
        qualifiedName: javaQualifiedName(packageName, owners, name),
        language:     'java',
      };
      result.nodes.push(codeNode);

      // Structural edges (written immediately — targets are node IDs)
      result.edges.push({
        source:     parentId,
        target:     codeNode.id,
        type:       'CONTAINS',
        confidence: 1,
        resolution: 'structural',
      });
      if (kind !== 'METHOD') {
        result.edges.push({
          source:     fileNode.id,
          target:     codeNode.id,
          type:       'DEFINES',
          confidence: 1,
          resolution: 'structural',
        });
      }

      // ── EXTENDS / IMPLEMENTS refs (second-pass, name-based) ──────────────
      if (kind === 'CLASS' || kind === 'INTERFACE') {
        this._extractInheritance(node, codeNode.id, result);
      }

      return codeNode;
    };

    const addCall = (node: SyntaxNode): void => {
      const owner  = ownerStack.at(-1);
      const callee = node.childForFieldName('name')?.text;
      if (!owner || !callee || callee === owner.name) return;

      const key = `${owner.id}::${callee}`;
      if (callsSeen.has(key)) return;
      callsSeen.add(key);

      result.edges.push({
        source:     owner.id,
        target:     callee,
        type:       'CALLS',
        confidence: 0.6,
        resolution: 'ast',
        sourceLine: node.startPosition.row + 1,
      });

      if (/^getConfiguration(Item)?$|^getConfigItem$/.test(callee)) {
        this._extractConfigEdges(node, owner.id, node.startPosition.row + 1, callsSeen, result);
      }
    };

    const visit = (node: SyntaxNode, parentId: string): void => {
      const kind = JAVA_KIND_MAP[node.type];
      if (kind !== undefined) {
        const codeNode = addDeclaration(node, parentId, kind);
        const isOwner  = kind === 'CLASS' || kind === 'INTERFACE' || kind === 'METHOD';
        if (isOwner) ownerStack.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id);
        if (isOwner) ownerStack.pop();
        return;
      }
      if (node.type === 'method_invocation') {
        addCall(node);
      }
      if (node.type === 'field_declaration') {
        this._extractInjects(node, ownerStack, result);
      }
      for (const child of node.namedChildren) visit(child, parentId);
    };

    visit(root, fileNode.id);
    return result;
  }

  // ── EXTENDS / IMPLEMENTS extraction ───────────────────────────────────────

  /**
   * Collect EXTENDS and IMPLEMENTS name references from a class/interface
   * declaration node. These are deferred to a second-pass resolution because
   * the parent class/interface may live in a different file.
   *
   * Java tree-sitter grammar:
   *   class_declaration
   *     superclass?  → superclass → type_identifier
   *     interfaces?  → super_interfaces → interface_type_list → interface_type → type_identifier
   *   interface_declaration
   *     extends_interfaces? → interface_type_list → type_identifier
   */
  private _extractInheritance(
    node:     SyntaxNode,
    sourceId: string,
    result:   ParseResult,
  ): void {
    for (const child of node.namedChildren) {
      // class extends SuperClass
      if (child.type === 'superclass') {
        const typeName = this._findTypeIdentifier(child);
        if (typeName) {
          result.extendsRefs.push({ sourceId, targetName: typeName });
        }
      }

      // class implements IfaceA, IfaceB
      if (child.type === 'super_interfaces' || child.type === 'interfaces') {
        const list = child.namedChildren.find(n => n.type === 'interface_type_list');
        const types = list?.namedChildren ?? child.namedChildren;
        for (const item of types) {
          const typeName = item.type === 'interface_type'
            ? this._findTypeIdentifier(item)
            : (item.type === 'type_identifier' ? item.text : null);
          if (typeName) {
            result.implementsRefs.push({ sourceId, targetName: typeName });
          }
        }
      }

      // interface extends IfaceA
      if (child.type === 'extends_interfaces') {
        const list = child.namedChildren.find(n => n.type === 'interface_type_list');
        const types = list?.namedChildren ?? child.namedChildren;
        for (const item of types) {
          const typeName = this._findTypeIdentifier(item);
          if (typeName) {
            result.extendsRefs.push({ sourceId, targetName: typeName });
          }
        }
      }
    }
  }

  /** Walk a subtree to find the first type_identifier text. */
  private _findTypeIdentifier(node: SyntaxNode): string | null {
    if (node.type === 'type_identifier') return node.text;
    for (const child of node.namedChildren) {
      const found = this._findTypeIdentifier(child);
      if (found) return found;
    }
    return null;
  }

  // ── INJECTS extraction ────────────────────────────────────────────────────

  /**
   * Detect CDI / Quarkus / Spring @Inject field declarations and emit an
   * INJECTS name-ref from the containing class to the injected type.
   *
   * Handles:
   *   @Inject SomeService svc;                → INJECTS SomeService
   *   @Inject Instance<SomeService> instances; → INJECTS SomeService (unwraps CDI wrapper)
   *   @Inject Event<OrderEvent> event;         → INJECTS OrderEvent
   *
   * Only field injection is covered here.  Constructor injection is covered by
   * the CALLS edges already emitted when the constructor body is visited.
   */
  private _extractInjects(
    node:       SyntaxNode,
    ownerStack: CodeNode[],
    result:     ParseResult,
  ): void {
    // Only emit from inside a CLASS, not an INTERFACE
    const owner = [...ownerStack].reverse().find(o => o.type === 'CLASS');
    if (!owner) return;

    // Check for @Inject (or @Autowired for Spring compat) in the modifier list
    const modifiers = node.namedChildren.find(n => n.type === 'modifiers');
    if (!modifiers) return;

    const INJECT_ANNOTATIONS = new Set(['Inject', 'Autowired']);
    const hasInject = modifiers.namedChildren.some(
      n => (n.type === 'marker_annotation' || n.type === 'annotation')
        && INJECT_ANNOTATIONS.has(this._annotationName(n) ?? ''),
    );
    if (!hasInject) return;

    const typeName = this._extractFieldTypeName(node);
    if (!typeName || typeName === owner.name) return;

    result.injectsRefs.push({ sourceId: owner.id, targetName: typeName });
  }

  /** Return the `name` attribute of an annotation node. */
  private _annotationName(node: SyntaxNode): string | null {
    return node.childForFieldName('name')?.text
      ?? node.namedChildren[0]?.text
      ?? null;
  }

  /**
   * Extract the primary type name from a field_declaration.
   * For generic wrappers (Instance<T>, Event<T>, Provider<T>) returns the
   * first type argument T rather than the wrapper, since that is what the
   * owning class actually depends on.
   */
  private _extractFieldTypeName(node: SyntaxNode): string | null {
    // CDI / Jakarta generic wrappers whose type-argument is the real dependency
    const CDI_WRAPPERS = new Set(['Instance', 'Event', 'Provider', 'InjectableInstance']);

    for (const child of node.namedChildren) {
      if (child.type === 'type_identifier') return child.text;

      if (child.type === 'generic_type') {
        const baseType = child.namedChildren.find(n => n.type === 'type_identifier');
        const typeArgs = child.namedChildren.find(n => n.type === 'type_arguments');

        if (baseType && CDI_WRAPPERS.has(baseType.text) && typeArgs) {
          // Unwrap: return the first concrete type argument
          const firstArg = typeArgs.namedChildren.find(n => n.type === 'type_identifier');
          if (firstArg) return firstArg.text;
        }

        // Non-wrapper generic or no type args — use the base type
        return baseType?.text ?? this._findTypeIdentifier(child);
      }
    }
    return null;
  }

  // ── READS_CONFIG extraction ───────────────────────────────────────────────

  private _extractConfigEdges(
    callNode:  SyntaxNode,
    ownerId:   string,
    sourceLine: number,
    seen:      Set<string>,
    result:    ParseResult,
  ): void {
    const args = callNode.childForFieldName('arguments');
    if (!args) return;
    for (const arg of args.namedChildren) {
      const constName = extractConstName(arg);
      if (!constName) continue;
      const key = `${ownerId}::config::${constName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.edges.push({
        source:     ownerId,
        target:     constName,
        type:       'READS_CONFIG',
        confidence: 0.9,
        resolution: 'ast',
        sourceLine,
      });
    }
  }
}
