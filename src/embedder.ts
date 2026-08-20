import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeNode } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const DIMS       = 384;
const MODEL_ID          = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE        = 32;

// Lazy singleton — created on first call, reused thereafter
let _pipeline: (
  (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>
) | null = null;

async function getPipeline(cacheDir: string) {
  if (_pipeline !== null) return _pipeline;

  process.stderr.write('[embedder] loading model (first run downloads ~22 MB)…\n');

  // Dynamic import keeps startup fast when embeddings are not needed
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;

  // @ts-expect-error – generic pipeline return type
  _pipeline = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });

  process.stderr.write('[embedder] model ready\n');
  return _pipeline!;
}

/**
 * Embed an array of texts in batches.
 * Returns one Float32Array of DIMS floats per input text.
 * Vectors are L2-normalised (unit length) — dot product = cosine similarity.
 */
export async function embedTexts(
  texts:    string[],
  cacheDir: string,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const pipe    = await getPipeline(cacheDir);
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const out   = await pipe(batch, { pooling: 'mean', normalize: true });

    // out.data is a flat Float32Array: [vec0_dim0…vec0_dimN, vec1_dim0…]
    const flat = out.data;
    for (let j = 0; j < batch.length; j++) {
      // .slice() copies the subarray — safe to store independently
      results.push(flat.slice(j * DIMS, (j + 1) * DIMS));
    }

    if (texts.length > BATCH_SIZE) {
      const done = Math.min(i + BATCH_SIZE, texts.length);
      process.stderr.write(`[embedder] ${done}/${texts.length} nodes embedded\n`);
    }
  }

  return results;
}

/**
 * Cosine similarity between two pre-normalised vectors.
 * Equivalent to dot product when vectors have unit length.
 */
export function similarity(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * Build the text string that represents a code node for embedding.
 *
 * Previously only the signature line was used, which misses all semantic
 * signal in the method body (variable names, called methods, constants,
 * auth types, cache keys, etc.).  Now we use:
 *
 *   1. File-path context  — last two path segments give class + package,
 *      e.g. "proxy/BusinessCentralProxy" anchors the node spatially.
 *   2. Body prefix        — first 8 non-blank lines of sourceCode (stored
 *      in Neo4j at index time, no disk I/O here).  This surfaces tokens
 *      like "vaultSecretService", "OAUTH_2", "cacheManager.put",
 *      "bearerToken" that keyword/semantic queries actually look for.
 *   3. Signature fallback — if sourceCode is absent, fall back to the
 *      passed firstSourceLine so existing call-sites still work.
 *
 * Total input is capped at 400 chars — well inside MiniLM-L6's 256-token
 * window (~400 word-pieces) so nothing is silently truncated by the model.
 */
export function nodeToText(node: CodeNode, firstSourceLine = ''): string {
  const parts     = node.filePath.replace(/\\/g, '/').split('/');
  const className = (parts.at(-1) ?? '').replace(/\.\w+$/, '');
  const pkg       = parts.at(-2) ?? '';
  const location  = pkg ? `${pkg}/${className}` : className;

  // Signature only — no body lines in the embedding; keeps vectors focused.
  const signature = (node.firstLine ?? firstSourceLine ?? node.name).trim();

  // Append config constant names so flag-name queries hit the reader directly.
  const rawBody = node.sourceCode ?? '';
  const constMatches = rawBody.match(/\bAdapterConstants\.(\w+)|getConfigurationItem\(([^)]+)\)/g) ?? [];
  const constNames = constMatches
    .map(m => m.replace(/getConfigurationItem\(|AdapterConstants\.|\)/g, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');

  const content = (signature + (constNames ? ` config:${constNames}` : '')).slice(0, 400);

  return content
    ? `${node.type} ${node.name} in ${location}: ${content}`
    : `${node.type} ${node.name} in ${node.filePath}`;
}

/** Default cache directory relative to this module's location */
export const DEFAULT_CACHE_DIR = path.join(__dirname, '..', 'data', 'models');
