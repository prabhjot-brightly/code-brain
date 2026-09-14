/**
 * embedders/local.ts
 * ───────────────────
 * Offline backend using Xenova/all-MiniLM-L6-v2 via @huggingface/transformers.
 * 384-dim, general-purpose, no API key required.
 *
 * Use this when EMBEDDER=local in the environment.
 * The HuggingFace pipeline is created lazily on first embed() call so the
 * MCP server starts fast regardless of backend choice.
 *
 * NOTE: switching from local (384-dim) to openai (1536-dim) requires
 * dropping and recreating the Neo4j vector index and re-running embed.
 * Set EMBEDDING_DIMS to match your active backend.
 */

import process from 'node:process';
import type { Embedder, InputType } from './base.js';

const MODEL_ID   = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 32;

type HFPipeline = (
  texts: string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

// Module-level singleton — shared across all LocalEmbedder instances
let _pipeline: HFPipeline | null = null;

export class LocalEmbedder implements Embedder {
  readonly dims = 384;

  constructor(private readonly cacheDir: string) {}

  async embed(texts: string[], _inputType?: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];

    const pipe    = await this._getPipeline();
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const out   = await pipe(batch, { pooling: 'mean', normalize: true });

      // out.data is a flat Float32Array: [vec0_dim0…dim383, vec1_dim0…]
      const flat = out.data;
      for (let j = 0; j < batch.length; j++) {
        results.push(
          Array.from(flat.slice(j * this.dims, (j + 1) * this.dims)),
        );
      }

      if (texts.length > BATCH_SIZE) {
        const done = Math.min(i + BATCH_SIZE, texts.length);
        process.stderr.write(`[embedder] ${done}/${texts.length} nodes embedded\n`);
      }
    }

    return results;
  }

  private async _getPipeline(): Promise<HFPipeline> {
    if (_pipeline !== null) return _pipeline;

    process.stderr.write('[embedder] loading local model (first run downloads ~22 MB)…\n');
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = this.cacheDir;

    // @ts-expect-error – generic pipeline return type
    _pipeline = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });

    process.stderr.write('[embedder] model ready\n');
    return _pipeline!;
  }
}
