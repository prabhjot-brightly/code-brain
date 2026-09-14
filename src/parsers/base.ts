/**
 * parsers/base.ts
 * ───────────────
 * Shared types for the language-parser adapter system.
 * Inspired by codegraph's TsParser / ParseResult pattern.
 *
 * To add support for a new language:
 *   1. Create src/parsers/<language>.ts implementing LanguageParser
 *   2. Register it in src/parsers/registry.ts
 */

import type { CodeNode, CodeEdge } from '../types.js';

// ── ParseResult ────────────────────────────────────────────────────────────────

/**
 * What a parser returns for one source file.
 *
 * `nodes` and direct `edges` (CONTAINS, DEFINES) are ready to upsert.
 * Name-based references — extends, implements, imports, calls — are collected
 * in separate lists and resolved in a second pass by the Indexer (same pattern
 * used by codegraph's loader).  This keeps parsers simple and avoids requiring
 * cross-file knowledge at parse time.
 */
export interface ParseResult {
  nodes: CodeNode[];
  edges: CodeEdge[];

  // ── Second-pass name references (resolved by Indexer after all nodes are stored)

  /** EXTENDS edges: (sourceNodeId, parentClassName) */
  extendsRefs:    Array<{ sourceId: string; targetName: string }>;
  /** IMPLEMENTS edges: (sourceNodeId, interfaceName) */
  implementsRefs: Array<{ sourceId: string; targetName: string }>;
  /** IMPORTS edges: (fileNodeId, importedQualifiedName) */
  importRefs:     Array<{ sourceId: string; targetName: string }>;
  /** INJECTS edges: (classNodeId, injectedTypeName) — CDI / Spring / Quarkus @Inject fields */
  injectsRefs:    Array<{ sourceId: string; targetName: string }>;
}

export function emptyParseResult(): ParseResult {
  return { nodes: [], edges: [], extendsRefs: [], implementsRefs: [], importRefs: [], injectsRefs: [] };
}

// ── LanguageParser ─────────────────────────────────────────────────────────────

/** Implement this interface to add support for a new programming language. */
export interface LanguageParser {
  /** Lower-case file extensions handled by this parser, e.g. ['.java']. */
  readonly extensions: readonly string[];
  /** Parse one source file; return nodes, structural edges, and name refs. */
  parse(absPath: string, repoRoot: string): ParseResult;
}
