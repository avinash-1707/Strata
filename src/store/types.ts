import type { MemoryStatus } from "../contracts.js";

/**
 * The persistence seam (DD-032). Domain methods, not SQL: `ToolDeps` holds a
 * `MemoryStore`, never a `Db`, because a `query(sql, params)` contract cannot be
 * faked without writing a SQL interpreter — which would make the fake-backed
 * tool tests unbuildable and their equivalence against real Postgres
 * unverifiable.
 *
 * This module imports only leaf types, so both the Postgres implementation and
 * the in-memory fake can depend on it.
 */
export interface MemoryStore {
  /** DD-020: an exact-duplicate `remember` returns the existing live row. */
  findLiveByContentHash(contentHash: string): Promise<MemoryRecord | undefined>;

  /** DD-005 stage 1 — the durable commit. No model output involved. */
  insertRaw(memory: NewMemory): Promise<MemoryRecord>;

  /**
   * DD-005 stage 2. Resolves `undefined` when the row is no longer live, which
   * happens when a `forget` lands between the insert and the enhancement.
   */
  applyEnhancement(id: string, enhancement: Enhancement): Promise<MemoryRecord | undefined>;

  /** DD-014: `websearch_to_tsquery` + `ts_rank_cd` over `summary_tsv`. */
  searchLexical(query: string, options: SearchOptions): Promise<readonly RankedMemory[]>;

  /**
   * Takes a query vector, never a query string: `src/store` must not reach for an
   * embedder, or the mutual isolation of db/cache/ollama collapses.
   */
  searchSemantic(
    vector: readonly number[],
    options: SearchOptions,
  ): Promise<readonly RankedMemory[]>;

  searchByTag(
    tags: readonly string[],
    match: "any" | "all",
    limit: number,
  ): Promise<readonly MemoryRecord[]>;

  /** DD-011: usage signal for compaction. Also runs on cache hits. */
  touchUsage(ids: readonly string[]): Promise<void>;

  /** DD-012: soft delete. `false` means no live row had that id. */
  softDelete(id: string): Promise<boolean>;

  /** DD-005 stage 3: rows left at `raw` or awaiting an embedding. */
  claimEnhancementBacklog(limit: number): Promise<readonly MemoryRecord[]>;
}

/**
 * Nullable columns are `T | null`, not optional. Under
 * `exactOptionalPropertyTypes` an optional property rejects an explicitly-undefined
 * value, and a row read from Postgres always *has* the key — it is the value that
 * is absent. `?:` is reserved for genuinely absent wire fields.
 */
export interface MemoryRecord {
  readonly id: string;
  readonly summary: string;
  readonly rawContent: string | null;
  readonly contentHash: string;
  readonly status: MemoryStatus;
  readonly needsEmbedding: boolean;
  readonly embeddingModel: string | null;
  readonly tags: readonly string[];
  readonly sessionId: string | null;
  readonly importance: number;
  readonly recallCount: number;
  readonly compactionDepth: number;
  readonly supersededBy: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly lastRecalledAt: Date | null;
}

export interface NewMemory {
  readonly summary: string;
  readonly rawContent: string;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly sessionId: string | null;
}

export interface Enhancement {
  readonly summary: string;
  readonly tags: readonly string[];
  /** `null` when compression succeeded but embedding did not (DD-005). */
  readonly embedding: readonly number[] | null;
  readonly embeddingModel: string | null;
}

export interface SearchOptions {
  readonly limit: number;
  /** DD-018: optional scope filter. */
  readonly sessionId?: string;
}

export interface RankedMemory {
  readonly memory: MemoryRecord;
  /** 1-based position in this ranker's output. RRF consumes rank, not score. */
  readonly rank: number;
  /** Raw cosine, from the semantic ranker only. */
  readonly similarity?: number;
}
