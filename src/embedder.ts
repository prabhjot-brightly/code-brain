/**
 * embedder.ts
 * ────────────
 * Public embedding API used by indexer and retriever.
 *
 * The actual model/backend lives in src/embedders/ — controlled by the
 * EMBEDDER env var (see src/embedders/index.ts).  This file owns:
 *
 *   embedTexts()  — thin wrapper around the active Embedder singleton
 *   nodeToText()  — text representation of a CodeNode for embedding;
 *                   model-agnostic, so it stays here rather than in each backend
 */

import { getEmbedder } from './embedders/index.js';
import type { InputType } from './embedders/base.js';
import type { CodeNode } from './types.js';

export type { InputType } from './embedders/base.js';

// ── embedTexts ───────────────────────────────────────────────────────────────

/**
 * Embed an array of texts using the active backend.
 * Returns one number[] per input text (dims depend on backend:
 * 1536 for OpenAI text-embedding-3-small, 384 for local Xenova).
 *
 * @param inputType — 'document' when indexing, 'query' when searching.
 *   Asymmetric models use different encoders for each; symmetric models
 *   (local) ignore this field.
 */
export async function embedTexts(
  texts:     string[],
  inputType: InputType = 'document',
): Promise<number[][]> {
  return getEmbedder().embed(texts, inputType);
}

// ── nodeToText ───────────────────────────────────────────────────────────────

/**
 * Build the text string that represents a code node for embedding.
 *
 * Packs: node type + name + file location (last two path segments) +
 * signature line + config constant names + key string literals + getter
 * names. Capped at 512 chars.
 *
 * Source code hints are extracted from the `sourceCode` property already
 * stored in Neo4j — no disk I/O required at embed time.
 */
export function nodeToText(node: CodeNode, firstSourceLine = ''): string {
  const parts     = node.filePath.replace(/\\/g, '/').split('/');
  const className = (parts.at(-1) ?? '').replace(/\.\w+$/, '');
  const pkg       = parts.at(-2) ?? '';
  const location  = pkg ? `${pkg}/${className}` : className;

  const signature = (node.firstLine ?? firstSourceLine ?? node.name).trim();

  // Append config constant names so flag-name queries hit the reader directly.
  const rawBody = node.sourceCode ?? '';
  const constMatches = rawBody.match(/\bAdapterConstants\.(\w+)|getConfigurationItem\(([^)]+)\)/g) ?? [];
  const constNames = constMatches
    .map(m => m.replace(/getConfigurationItem\(|AdapterConstants\.|\)/g, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');

  // Human-readable string literals are the richest semantic signal in a method.
  const stringLiterals = rawBody.match(/"([^"\\]{8,100})"/g) ?? [];
  const keyStrings = stringLiterals
    .map(s => s.slice(1, -1).trim())
    .filter(s => /[A-Za-z]{3}/.test(s) && !/^https?:\/\/|^\$\{|^[A-Z_]{6,}$/.test(s))
    .slice(0, 3)
    .join(' ');

  // Getter property names this method reads.
  const getterMatches = rawBody.match(/\.get([A-Z][a-zA-Z]{2,})\(\)/g) ?? [];
  const getterNames   = getterMatches
    .map(m => m.replace(/^\.|get|\(\)/g, ''))
    .slice(0, 4)
    .join(' ');

  const extras  = [constNames && `config:${constNames}`, keyStrings, getterNames].filter(Boolean).join(' ');
  const content = (signature + (extras ? ` ${extras}` : '')).slice(0, 512);

  return content
    ? `${node.type} ${node.name} in ${location}: ${content}`
    : `${node.type} ${node.name} in ${node.filePath}`;
}
