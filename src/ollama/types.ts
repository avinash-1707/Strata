/**
 * The model seam. Exactly two operations, and it knows nothing about memories,
 * Postgres, or Redis. Both are best-effort from a tool's point of view: Ollama is
 * not load-bearing, so every caller degrades rather than fails (DD-005).
 */
export interface Ollama {
  embed(text: string, kind: EmbeddingKind): Promise<Embedding>;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}

/**
 * Which side of the biencoder a text is on. The `search_document:` /
 * `search_query:` prefixes exist to break biencoder symmetry, and the client
 * applies them keyed off model family — never the call site, and never
 * unconditionally, since prefixing a non-nomic model corrupts its embeddings just
 * as badly as omitting the prefix corrupts nomic's (DD-008).
 */
export type EmbeddingKind = "document" | "query";

export interface Embedding {
  readonly vector: readonly number[];
  /** DD-009: mixing models silently produces meaningless similarities, so the
   *  producing model travels with the vector rather than being looked up later. */
  readonly model: string;
}

export interface GenerateOptions {
  /**
   * A JSON Schema for Ollama's structured-output `format`, not `format: "json"`
   * (DD-006). Absent for synthesis, which returns prose.
   */
  readonly format?: Record<string, unknown>;
  /** Defaults to 0 for compression: determinism matters more than creativity. */
  readonly temperature?: number;
  readonly timeoutMs?: number;
}
