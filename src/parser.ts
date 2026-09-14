/**
 * parser.ts — backward-compatibility shim
 * ─────────────────────────────────────────
 * The parsing logic now lives in src/parsers/.
 * This file re-exports the public API so existing imports keep working.
 *
 * To add a new language: register a LanguageParser in src/parsers/registry.ts.
 */

export { parseFile, registerParser, supportedExtensions } from './parsers/registry.js';
export type { ParseResult, LanguageParser } from './parsers/registry.js';
