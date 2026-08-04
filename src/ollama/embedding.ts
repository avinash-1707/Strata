import { StrataError } from "../errors.js";

/**
 * `nomic-embed-text`'s output width, and the `vector(768)` column's declared
 * width. A mismatch is unrecoverable without re-embedding the whole corpus, so it
 * is checked rather than trusted.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * The only implementation of the dimension check, used by both the real client and
 * the fake, so `EMBEDDING_DIM_MISMATCH` cannot be raised in two subtly different
 * ways. Also rejects non-finite components: pgvector refuses NaN and Infinity, and
 * catching them here turns a confusing insert failure into a named degradation
 * (DD-005 — the row keeps `needs_embedding`, the write still stands).
 */
export function assertEmbeddingDimensions(
  vector: readonly number[],
  model: string,
): readonly number[] {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new StrataError(
      "EMBEDDING_DIM_MISMATCH",
      `Embedding model returned ${String(vector.length)} dimensions, expected ${String(EMBEDDING_DIMENSIONS)}`,
      { details: { model, expected: EMBEDDING_DIMENSIONS, actual: vector.length } },
    );
  }

  const badIndex = vector.findIndex((value) => !Number.isFinite(value));
  if (badIndex !== -1) {
    throw new StrataError(
      "EMBEDDING_DIM_MISMATCH",
      `Embedding contains a non-finite value at index ${String(badIndex)}`,
      { details: { model, index: badIndex } },
    );
  }

  return vector;
}
