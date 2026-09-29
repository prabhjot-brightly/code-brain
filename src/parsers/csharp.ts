import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import treeSitterCSharp from 'tree-sitter-c-sharp';
import type { CodeNode, NodeType } from '../types.js';
import type { LanguageParser, ParseResult } from './base.js';
import { emptyParseResult } from './base.js';

interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

const parser = new Parser() as {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: SyntaxNode };
};
parser.setLanguage(treeSitterCSharp as unknown);

const DECLARATIONS: Record<string, NodeType> = {
  class_declaration: 'CLASS',
  record_declaration: 'CLASS',
  struct_declaration: 'CLASS',
  enum_declaration: 'CLASS',
  interface_declaration: 'INTERFACE',
  method_declaration: 'METHOD',
  constructor_declaration: 'METHOD',
  local_function_statement: 'FUNCTION',
};

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function typeName(node: SyntaxNode): string {
  if (node.type === 'generic_name' || node.type === 'qualified_name' || node.type === 'alias_qualified_name') {
    return node.childForFieldName('name')?.text ?? node.namedChildren[0]?.text ?? node.text;
  }
  return node.text;
}

function documentation(lines: string[], startLine: number): string | undefined {
  const comments: string[] = [];
  for (let index = startLine - 2; index >= 0; index--) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('//')) break;
    comments.unshift(line.replace(/^\/\/\/?\s?/, ''));
  }
  return comments.join('\n').trim() || undefined;
}

export class CSharpParser implements LanguageParser {
  readonly extensions = ['.cs'] as const;

  parse(absPath: string, repoRoot: string): ParseResult {
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch {
      return emptyParseResult();
    }

    const relPath = path.relative(repoRoot, absPath).replaceAll('\\', '/');
    const lines = source.split('\n');
    const result = emptyParseResult();
    const root = parser.parse(source).rootNode;
    const fileNode: CodeNode = {
      id: `${relPath}:FILE:${relPath}:0`,
      type: 'FILE',
      name: path.basename(relPath),
      filePath: relPath,
      startLine: 1,
      endLine: lines.length,
      hash: hash(source),
      qualifiedName: relPath,
      language: 'csharp',
    };
    result.nodes.push(fileNode);

    const owners: CodeNode[] = [];
    const callsSeen = new Set<string>();
    const fileNamespace = root.namedChildren.find(child => child.type === 'file_scoped_namespace_declaration');
    const namespaceName = fileNamespace?.childForFieldName('name')?.text ?? '';

    const visit = (node: SyntaxNode, parentId: string, currentNamespace: string): void => {
      if (node.type === 'namespace_declaration') {
        const name = node.childForFieldName('name')?.text ?? '';
        const nestedNamespace = [currentNamespace, name].filter(Boolean).join('.');
        for (const child of node.namedChildren) visit(child, parentId, nestedNamespace);
        return;
      }

      if (node.type === 'using_directive') {
        const imported = node.namedChildren.find(child =>
          child.type === 'qualified_name' || child.type === 'identifier' || child.type === 'generic_name',
        );
        if (imported) result.importRefs.push({ sourceId: fileNode.id, targetName: imported.text });
        return;
      }

      const kind = DECLARATIONS[node.type];
      if (kind) {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const codeNode: CodeNode = {
          id: `${relPath}:${kind}:${name}:${startLine}`,
          type: kind,
          name,
          filePath: relPath,
          startLine,
          endLine,
          hash: hash(lines.slice(startLine - 1, endLine).join('\n')),
          documentation: documentation(lines, startLine),
          qualifiedName: [currentNamespace, ...owners.map(owner => owner.name), name].filter(Boolean).join('.'),
          language: 'csharp',
        };
        result.nodes.push(codeNode);
        result.edges.push({ source: parentId, target: codeNode.id, type: 'CONTAINS', confidence: 1, resolution: 'structural' });
        if (kind === 'CLASS' || kind === 'INTERFACE') {
          result.edges.push({ source: fileNode.id, target: codeNode.id, type: 'DEFINES', confidence: 1, resolution: 'structural' });
          const bases = node.type === 'enum_declaration' ? []
            : node.namedChildren.find(child => child.type === 'base_list')?.namedChildren ?? [];
          for (const [index, base] of bases.entries()) {
            const targetName = typeName(base);
            const isImplementation = kind === 'CLASS' && (node.type === 'struct_declaration'
              || index > 0 || /^I[A-Z]/.test(targetName));
            (isImplementation ? result.implementsRefs : result.extendsRefs).push({ sourceId: codeNode.id, targetName });
          }
        }

        owners.push(codeNode);
        for (const child of node.namedChildren) visit(child, codeNode.id, currentNamespace);
        owners.pop();
        return;
      }

      if (node.type === 'invocation_expression') {
        const owner = owners.at(-1);
        const functionNode = node.childForFieldName('function');
        const name = functionNode?.type === 'identifier' ? functionNode.text
          : functionNode?.childForFieldName('name')?.text
            ?? functionNode?.namedChildren.at(-1)?.text;
        if (owner && (owner.type === 'METHOD' || owner.type === 'FUNCTION') && name && name !== owner.name) {
          const key = `${owner.id}::${name}`;
          if (!callsSeen.has(key)) {
            callsSeen.add(key);
            result.edges.push({ source: owner.id, target: name, type: 'CALLS', confidence: 0.6, resolution: 'ast', sourceLine: node.startPosition.row + 1 });
          }
        }
      }

      for (const child of node.namedChildren) visit(child, parentId, currentNamespace);
    };

    visit(root, fileNode.id, namespaceName);
    return result;
  }
}