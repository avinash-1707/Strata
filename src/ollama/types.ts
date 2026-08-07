/**
 * The model seam. Exactly two operations, and it knows nothing about memories,
 * Postgres, or Redis. Both are best-effort from a tool's point of view: Ollama is
 * not load-bearing, so every caller degrades rather than fails (DD-005).
 */
export interface Ollama {
  embed(text: string, kind: EmbeddingKind, options?: ModelCallOptions): Promise<Embedding>;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}

/**
 * Both calls take a caller-supplied budget because there are two different ones.
 * `OLLAMA_TIMEOUT_MS` bounds a single call generously, since CPU-bound generation
 * is slow (DD-028). DD-005 stage 2 needs a much tighter bound: it runs inline on
 * the write path, and a slow model there should degrade to `status: 'raw'` in
 * seconds rather than hold the agent for the full per-call ceiling.
 */
export interface ModelCallOptions {
  readonly timeoutMs?: number;

  /**
   * Cancels the call before its timeout. Distinct from `timeoutMs` because the two
   * answer different questions: the timeout bounds how long *this* call may take,
   * while the signal says the process no longer wants the answer. Shutdown needs the
   * second — a 60 s generation holds the repair pass's pooled connection, and
   * `pool.end()` cannot finish behind it (DD-045).
   */
  readonly signal?: AbortSignal;
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

export interface GenerateOptions extends ModelCallOptions {
  /**
   * A JSON Schema for Ollama's structured-output `format`, not `format: "json"`
   * (DD-006). Absent for synthesis, which returns prose.
   */
  readonly format?: Record<string, unknown>;
  /** Defaults to 0 for compression: determinism matters more than creativity. */
  readonly temperature?: number;
}
