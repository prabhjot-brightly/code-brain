/**
 * embedders/index.ts
 * ───────────────────
 * Factory that returns the active Embedder singleton, chosen by the
 * EMBEDDER environment variable:
 *
 *   EMBEDDER=openai  (default) — OpenAI text-embedding-3-small, 1536-dim
 *                                 requires OPENAI_API_KEY
 *   EMBEDDER=local             — Xenova/all-MiniLM-L6-v2, 384-dim, offline
 *                                 optional EMBEDDER_CACHE_DIR for model storage
 *
 * Both classes are imported statically (no dynamic require) so the TypeScript
 * compiler sees them. The heavy initialisation (model download / API client)
 * is deferred to the first embed() call inside each class.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { OpenAIEmbedder } from './openai.js';
import { LocalEmbedder }  from './local.js';

export type { Embedder, InputType } from './base.js';

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: OpenAIEmbedder | LocalEmbedder | null = null;

/**
 * Returns the active embedder singleton (created once, reused thereafter).
 * The backend is fixed at first call — changing EMBEDDER at runtime has no
 * effect once this function has been called.
 */
export function getEmbedder(): OpenAIEmbedder | LocalEmbedder {
  if (_instance !== null) return _instance;

  const backend = (process.env['EMBEDDER'] ?? 'openai').toLowerCase();

  if (backend === 'local') {
    const cacheDir = process.env['EMBEDDER_CACHE_DIR']
      ?? path.join(os.homedir(), '.cache', 'repo-knowledge-graph', 'models');
    _instance = new LocalEmbedder(cacheDir);
    process.stderr.write(`[embedder] backend=local  model=bge-large-en-v1.5  cache=${cacheDir}\n`);
  } else {
    _instance = new OpenAIEmbedder();
    process.stderr.write('[embedder] backend=openai  model=text-embedding-3-small\n');
  }

  return _instance;
}
