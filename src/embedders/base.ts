/**
 * embedders/base.ts
 * ──────────────────
 * Core interface for embedding backends.
 *
 * InputType mirrors the asymmetric encoding used by modern embedding APIs
 * (Voyage, OpenAI v3): 'document' for content being indexed, 'query' for
 * the search-time question. Symmetric models (local Xenova) ignore this.
 */

export type InputType = 'document' | 'query';

export interface Embedder {
  /** Dimensionality of every output vector (e.g. 1536 for OpenAI, 384 for local). */
  readonly dims: number;

  /**
   * Embed an array of texts and return one float[] per input.
   * @param texts    — plain strings; caller is responsible for length limits.
   * @param inputType — 'document' when indexing, 'query' when searching.
   */
  embed(texts: string[], inputType?: InputType): Promise<number[][]>;
}
