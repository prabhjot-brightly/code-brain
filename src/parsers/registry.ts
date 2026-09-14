/**
 * parsers/registry.ts
 * ────────────────────
 * Central registry that maps file extensions to LanguageParser instances.
 *
 * Default parsers registered here:
 *   .java → JavaParser
 *
 * To add a new language at runtime call registerParser():
 *   import { registerParser } from './parsers/registry.js';
 *   import { KotlinParser } from './parsers/kotlin.js';
 *   registerParser(new KotlinParser());
 */

import path from 'node:path';
import type { LanguageParser, ParseResult } from './base.js';
import { emptyParseResult } from './base.js';
import { JavaParser } from './java.js';

// ── Built-in parsers ──────────────────────────────────────────────────────────

const _registry = new Map<string, LanguageParser>();

function _register(parser: LanguageParser): void {
  for (const ext of parser.extensions) {
    _registry.set(ext, parser);
  }
}

// Register defaults
_register(new JavaParser());

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a language parser for one or more file extensions.
 * Call this before indexing starts to add community or custom parsers.
 */
export function registerParser(parser: LanguageParser): void {
  _register(parser);
}

/** All file extensions currently handled by a registered parser. */
export function supportedExtensions(): string[] {
  return [..._registry.keys()];
}

/**
 * Parse a source file using the registered parser for its extension.
 * Returns an empty ParseResult for unsupported file types (no error thrown).
 */
export function parseFile(absPath: string, repoRoot: string): ParseResult {
  const ext    = path.extname(absPath).toLowerCase();
  const parser = _registry.get(ext);
  if (!parser) return emptyParseResult();
  return parser.parse(absPath, repoRoot);
}

// Re-export types so callers only need one import
export type { ParseResult, LanguageParser } from './base.js';
