/**
 * parsers/typescript.ts
 * ──────────────────────
 * TypeScript / TSX language parser adapter using tree-sitter.
 * Implements LanguageParser — registered in registry.ts.
 *
 * Extracts:
 *   Nodes  — FILE, CLASS (incl. abstract + enums), INTERFACE, METHOD, FUNCTION
 *   Edges  — CONTAINS, DEFINES (structural, written immediately)
 *   Refs   — EXTENDS, IMPLEMENTS, IMPORTS (name-based, resolved in second pass by Indexer)
 *   Calls  — CALLS (name-based, resolved by Indexer's batchUpsertCallEdges)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
// tree-sitter-typescript exports { typescript, tsx } as named sub-grammars
import treeSitterTypeScript from 'tree-sitter-typescript';
import type { CodeNode, CodeEdge, NodeType } from '../types.js';
import type { LanguageParser, ParseResult } from './base.js';
import { emptyParseResult } from './base.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function nodeId(filePath: string, type: NodeType, name: string, line: number): string {
  return `${filePath}:${type}:${name}:${line}`;
}

/**
 * Extract the leading JSDoc or single-line comment block immediately above
 * `startLine` (1-based).
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
  children: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

function makeParser(grammar: unknown): { parse(s: string): { rootNode: SyntaxNode } } {
  const p = new Parser() as {
    setLanguage(l: unknown): void;
    parse(s: string): { rootNode: SyntaxNode };
  };
  p.setLanguage(grammar);
  return p;
}

// Lazily constructed so the module loads fast when only Java is used.
let _tsParser:  ReturnType<typeof makeParser> | undefined;
let _tsxParser: ReturnType<typeof makeParser> | undefined;

function getTsParser():  ReturnType<typeof makeParser> {
  return (_tsParser  ??= makeParser((treeSitterTypeScript as { typescript: unknown; tsx: unknown }).typescript));
}
function getTsxParser(): ReturnType<typeof makeParser> {
  return (_tsxParser ??= makeParser((treeSitterTypeScript as { typescript: unknown; tsx: unknown }).tsx));
}

// ── Node-type maps ─────────────────────────────────────────────────────────────

/** TypeScript tree-sitter node types that map to graph NodeType */
const TS_CLASS_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',                 // anonymous class expression assigned to a variable
]);

const TS_INTERFACE_TYPES = new Set([
  'interface_declaration',
]);

const TS_METHOD_TYPES = new Set([
  'method_definition',
  'method_signature',
  'abstract_method_signature',
]);

const TS_FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
]);

/**
 * Arrow functions or function expressions assigned to a `const`/`let`/`var`
 * are unwrapped one level up at the lexical_declaration / variable_declarator
 * level — see _tryExtractVariableFunction().
 */
const TS_CALL_TYPES = new Set([
  'call_expression',
]);

// ── TypeScriptParser class ─────────────────────────────────────────────────────

export class TypeScriptParser implements LanguageParser {
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

  parse(absPath: string, repoRoot: string): ParseResult {
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch {
      return emptyParseResult();
    }
    const relPath = path.relative(repoRoot, absPath).replaceAll('\\', '/');
    const ext = path.extname(absPath).toLowerCase();
    const parser = (ext === '.tsx' || ext === '.jsx') ? getTsxParser() : getTsParser();
    return this._parseSource(relPath, source, parser);
  }

  // ── Internal parsing ─────────────────────────────────────────────────────────

  private _parseSource(
    relPath: string,
    source:  string,
    parser:  ReturnType<typeof makeParser>,
  ): ParseResult {
    const lines  = source.split('\n');
    const result = emptyParseResult();
    let   tree: { rootNode: SyntaxNode };

    try {
      tree = parser.parse(source);
    } catch {
      return result; // unparseable file — return empty rather than crash
    }

    // ── File node ────────────────────────────────────────────────────────────
    const fileNode: CodeNode = {
      id:            nodeId(relPath, 'FILE', relPath, 0),
      type:          'FILE',
      name:          path.basename(relPath),
      filePath:      relPath,
      startLine:     1,
      endLine:       lines.length,
      hash:          contentHash(source),
      qualifiedName: relPath,
      language:      'typescript',
    };
    result.nodes.push(fileNode);

    const ownerStack: CodeNode[] = [];
    const callsSeen   = new Set<string>();

    // ── Walk the AST ─────────────────────────────────────────────────────────
    const visit = (node: SyntaxNode, parentId: string): void => {

      // ── Class ──────────────────────────────────────────────────────────────
      if (TS_CLASS_TYPES.has(node.type)) {
        const codeNode = this._addTypeNode(node, parentId, fileNode, 'CLASS', lines, result);
        this._extractClassInheritance(node, codeNode.id, result);
        ownerStack.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id);
        ownerStack.pop();
        return;
      }

      // ── Interface ──────────────────────────────────────────────────────────
      if (TS_INTERFACE_TYPES.has(node.type)) {
        const codeNode = this._addTypeNode(node, parentId, fileNode, 'INTERFACE', lines, result);
        this._extractInterfaceInheritance(node, codeNode.id, result);
        ownerStack.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id);
        ownerStack.pop();
        return;
      }

      // ── Method (inside class/interface body) ───────────────────────────────
      if (TS_METHOD_TYPES.has(node.type)) {
        const codeNode = this._addMethodNode(node, parentId, fileNode, lines, result);
        ownerStack.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id);
        ownerStack.pop();
        return;
      }

      // ── Top-level named function declaration ───────────────────────────────
      if (TS_FUNCTION_TYPES.has(node.type)) {
        const codeNode = this._addFunctionNode(node, parentId, fileNode, lines, result);
        ownerStack.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id);
        ownerStack.pop();
        return;
      }

      // ── const/let foo = () => … or function expression ─────────────────────
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const fn = this._tryExtractVariableFunction(declarator, parentId, fileNode, lines, result);
          if (fn) {
            ownerStack.push(fn);
            const body = declarator.namedChildren.at(-1);
            if (body) visit(body, fn.id);
            ownerStack.pop();
          } else {
            for (const child of declarator.namedChildren) visit(child, parentId);
          }
        }
        return;
      }

      // ── Export statement — unwrap and visit inner declaration ──────────────
      if (node.type === 'export_statement') {
        for (const child of node.namedChildren) visit(child, parentId);
        return;
      }

      // ── Call expression → CALLS edge ───────────────────────────────────────
      if (TS_CALL_TYPES.has(node.type)) {
        this._addCallEdge(node, ownerStack, callsSeen, result);
        for (const child of node.namedChildren) visit(child, parentId);
        return;
      }

      // ── Import statement → importRefs (second pass) ────────────────────────
      if (node.type === 'import_statement') {
        this._extractImports(node, fileNode.id, result);
        return;
      }

      for (const child of node.namedChildren) visit(child, parentId);
    };

    visit(tree.rootNode, fileNode.id);
    return result;
  }

  // ── Node creation helpers ─────────────────────────────────────────────────

  private _addTypeNode(
    node:     SyntaxNode,
    parentId: string,
    fileNode: CodeNode,
    kind:     'CLASS' | 'INTERFACE',
    lines:    string[],
    result:   ParseResult,
  ): CodeNode {
    const name  = node.childForFieldName('name')?.text ?? '<anonymous>';
    const start = node.startPosition.row + 1;
    const end   = node.endPosition.row + 1;

    const codeNode: CodeNode = {
      id:            nodeId(fileNode.filePath, kind, name, start),
      type:          kind,
      name,
      filePath:      fileNode.filePath,
      startLine:     start,
      endLine:       end,
      hash:          contentHash(lines.slice(start - 1, end).join('\n')),
      documentation: extractLeadingComment(lines, start),
      qualifiedName: name,
      language:      'typescript',
    };
    result.nodes.push(codeNode);

    result.edges.push({ source: parentId,       target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
    result.edges.push({ source: fileNode.id,    target: codeNode.id, type: 'DEFINES',  confidence: 1, resolution: 'structural' });
    return codeNode;
  }

  private _addMethodNode(
    node:     SyntaxNode,
    parentId: string,
    fileNode: CodeNode,
    lines:    string[],
    result:   ParseResult,
  ): CodeNode {
    const name  = node.childForFieldName('name')?.text ?? '<anonymous>';
    const start = node.startPosition.row + 1;
    const end   = node.endPosition.row + 1;

    const codeNode: CodeNode = {
      id:            nodeId(fileNode.filePath, 'METHOD', name, start),
      type:          'METHOD',
      name,
      filePath:      fileNode.filePath,
      startLine:     start,
      endLine:       end,
      hash:          contentHash(lines.slice(start - 1, end).join('\n')),
      documentation: extractLeadingComment(lines, start),
      qualifiedName: name,
      language:      'typescript',
    };
    result.nodes.push(codeNode);
    result.edges.push({ source: parentId, target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
    return codeNode;
  }

  private _addFunctionNode(
    node:     SyntaxNode,
    parentId: string,
    fileNode: CodeNode,
    lines:    string[],
    result:   ParseResult,
  ): CodeNode {
    const name  = node.childForFieldName('name')?.text ?? '<anonymous>';
    const start = node.startPosition.row + 1;
    const end   = node.endPosition.row + 1;

    const codeNode: CodeNode = {
      id:            nodeId(fileNode.filePath, 'FUNCTION', name, start),
      type:          'FUNCTION',
      name,
      filePath:      fileNode.filePath,
      startLine:     start,
      endLine:       end,
      hash:          contentHash(lines.slice(start - 1, end).join('\n')),
      documentation: extractLeadingComment(lines, start),
      qualifiedName: name,
      language:      'typescript',
    };
    result.nodes.push(codeNode);
    result.edges.push({ source: parentId,    target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
    result.edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES',  confidence: 1, resolution: 'structural' });
    return codeNode;
  }

  /**
   * `const foo = () => …` or `const foo = function() { … }`.
   * Returns the created FUNCTION node if the declarator holds a function,
   * undefined otherwise.
   */
  private _tryExtractVariableFunction(
    declarator: SyntaxNode,
    parentId:   string,
    fileNode:   CodeNode,
    lines:      string[],
    result:     ParseResult,
  ): CodeNode | undefined {
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || !valueNode) return undefined;

    const isFunctionLike = (
      valueNode.type === 'arrow_function'       ||
      valueNode.type === 'function'             ||
      valueNode.type === 'function_expression'  ||
      valueNode.type === 'generator_function'
    );
    if (!isFunctionLike) return undefined;

    const name  = nameNode.text;
    const start = declarator.startPosition.row + 1;
    const end   = declarator.endPosition.row + 1;

    const codeNode: CodeNode = {
      id:            nodeId(fileNode.filePath, 'FUNCTION', name, start),
      type:          'FUNCTION',
      name,
      filePath:      fileNode.filePath,
      startLine:     start,
      endLine:       end,
      hash:          contentHash(lines.slice(start - 1, end).join('\n')),
      documentation: extractLeadingComment(lines, start),
      qualifiedName: name,
      language:      'typescript',
    };
    result.nodes.push(codeNode);
    result.edges.push({ source: parentId,    target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
    result.edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES',  confidence: 1, resolution: 'structural' });
    return codeNode;
  }

  // ── Inheritance extraction ────────────────────────────────────────────────

  /**
   * class Foo extends Bar implements Baz { … }
   *
   * tree-sitter-typescript grammar:
   *   class_declaration
   *     class_heritage
   *       extends_clause → type_identifier | generic_type
   *       implements_clause → type_list → type_identifier | generic_type …
   */
  private _extractClassInheritance(node: SyntaxNode, sourceId: string, result: ParseResult): void {
    const heritage = node.namedChildren.find(n => n.type === 'class_heritage');
    if (!heritage) return;

    for (const clause of heritage.namedChildren) {
      if (clause.type === 'extends_clause') {
        for (const child of clause.namedChildren) {
          const name = this._typeIdentifierName(child);
          if (name) result.extendsRefs.push({ sourceId, targetName: name });
        }
      }
      if (clause.type === 'implements_clause') {
        // implements_clause → type_list OR direct type children
        const typeList = clause.namedChildren.find(n => n.type === 'type_list') ?? clause;
        for (const child of typeList.namedChildren) {
          const name = this._typeIdentifierName(child);
          if (name) result.implementsRefs.push({ sourceId, targetName: name });
        }
      }
    }
  }

  /**
   * interface Foo extends Bar, Baz { … }
   *
   *   interface_declaration
   *     extends_type_clause → type_list → type_identifier | generic_type …
   */
  private _extractInterfaceInheritance(node: SyntaxNode, sourceId: string, result: ParseResult): void {
    for (const child of node.namedChildren) {
      if (child.type === 'extends_type_clause') {
        const typeList = child.namedChildren.find(n => n.type === 'type_list') ?? child;
        for (const item of typeList.namedChildren) {
          const name = this._typeIdentifierName(item);
          if (name) result.extendsRefs.push({ sourceId, targetName: name });
        }
      }
    }
  }

  /** Return the bare identifier name from a type node (unwrap generics). */
  private _typeIdentifierName(node: SyntaxNode): string | null {
    if (node.type === 'type_identifier') return node.text;
    if (node.type === 'identifier')      return node.text;
    if (node.type === 'generic_type') {
      const base = node.namedChildren.find(n => n.type === 'type_identifier' || n.type === 'identifier');
      return base?.text ?? null;
    }
    // Qualified names: Foo.Bar — use the last segment
    if (node.type === 'member_expression' || node.type === 'nested_type_identifier') {
      return node.text.split('.').at(-1) ?? null;
    }
    return null;
  }

  // ── Import extraction ─────────────────────────────────────────────────────

  /**
   * import { Foo, Bar } from './foo';
   * import DefaultFoo from './foo';
   * import * as ns from './foo';
   *
   * Stores the module specifier as importRef (second-pass resolved).
   */
  private _extractImports(node: SyntaxNode, fileNodeId: string, result: ParseResult): void {
    const source = node.namedChildren.find(n => n.type === 'string');
    if (!source) return;
    // Strip quotes
    const modulePath = source.text.replace(/^['"]|['"]$/g, '');
    result.importRefs.push({ sourceId: fileNodeId, targetName: modulePath });
  }

  // ── Call edges ────────────────────────────────────────────────────────────

  /**
   * Emit a CALLS edge from the innermost enclosing method/function to the
   * callee name. Only direct identifier calls are captured (foo(), this.foo());
   * dynamic/computed calls are skipped.
   */
  private _addCallEdge(
    node:       SyntaxNode,
    ownerStack: CodeNode[],
    callsSeen:  Set<string>,
    result:     ParseResult,
  ): void {
    const owner = ownerStack.at(-1);
    if (!owner) return;

    const fn = node.childForFieldName('function');
    if (!fn) return;

    let callee: string | undefined;
    if (fn.type === 'identifier') {
      callee = fn.text;
    } else if (fn.type === 'member_expression') {
      callee = fn.childForFieldName('property')?.text;
    }
    if (!callee || callee === owner.name) return;

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
  }
}
