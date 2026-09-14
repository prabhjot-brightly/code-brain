/**
 * embedders/openai.ts
 * ────────────────────
 * OpenAI text-embedding-3-small backend (1536-dim, code-aware).
 *
 * Requires OPENAI_API_KEY in the environment.
 * The `openai` package is imported lazily so startup stays fast when
 * using the local backend.
 */

import process from 'node:process';
import type { Embedder, InputType } from './base.js';

/** OpenAI batch limit is 2 048 inputs; 100 is a safe default for large text. */
const BATCH_SIZE = 100;
const MODEL      = 'text-embedding-3-small';

export class OpenAIEmbedder implements Embedder {
  readonly dims = 1536;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    if (!key) {
      throw new Error(
        'OpenAI API key not found. Set OPENAI_API_KEY in .env or pass apiKey to OpenAIEmbedder.',
      );
    }
    this.apiKey = key;
  }

  async embed(texts: string[], _inputType?: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Lazy import — only pulled in when this backend is active
    // @ts-expect-error – openai must be installed (npm install)
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.apiKey });
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res   = await client.embeddings.create({ model: MODEL, input: batch });

      // Sort by index to guarantee order regardless of API response order
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results.push(...(res.data as any[]).sort((a, b) => a.index - b.index).map(d => d.embedding as number[]));

      if (texts.length > BATCH_SIZE) {
        const done = Math.min(i + BATCH_SIZE, texts.length);
        process.stderr.write(`[embedder] ${done}/${texts.length} nodes embedded\n`);
      }
    }

    return results;
  }
}
