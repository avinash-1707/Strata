import type { MemoryStatus } from "../contracts/common.js";

/**
 * The persistence seam: domain methods, not SQL (DD-032). Imports only leaf types,
 * so the Postgres implementation and the in-memory fake can both depend on it.
 */
export interface MemoryStore {
  /** DD-020: an exact-duplicate `remember` returns the existing live row. */
  findLiveByContentHash(contentHash: string): Promise<MemoryRecord | undefined>;

  /**
   * DD-005 stage 1 — the durable commit. No model output involved.
   *
   * **Must be conflict-tolerant.** `memories_hash_live_idx` is unique over live rows,
   * and two `remember` calls can both pass `findLiveByContentHash` before either
   * inserts — one MCP, one REST, in the same process. A plain insert then raises
   * 23505 and tells the caller the write failed. Implementations do
   * `on conflict … do nothing` and re-select, returning the winning row, so a losing
   * racer still gets a durable id (DD-020).
   */
  insertRaw(memory: NewMemory): Promise<MemoryRecord>;

  /**
   * DD-005 stage 2. Resolves `undefined` when the row is no longer live, which
   * happens when a `forget` lands between the insert and the enhancement.
   *
   * Clears `enhancement_attempts` and `last_attempt_at`: this row just made
   * progress, so its failure history is spent. Without the reset a row that
   * eventually compressed would still be one bad day from the cap (DD-045).
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

  /**
   * Inverse of `softDelete` (DD-039). Clears `deleted_at`, and only for rows where
   * `superseded_by is null`: resurrecting a compaction input would duplicate content
   * its merged replacement already covers. `false` means no restorable row — which is
   * also the answer for a row that was never deleted.
   *
   * The caller bumps the corpus version, as it does for `forget`. A restored memory is
   * visible again, so any cached recall that omitted it is stale (DD-010).
   *
   * Also `false` when a **live row already holds this row's `content_hash`** — which
   * is reachable precisely because the unique index is partial: forget X, remember the
   * same content, then try to restore X. Restoring would violate the index, so the
   * answer is "not restorable", not an error. An operator who wants X specifically
   * must forget the newer row first.
   */
  restore(id: string): Promise<boolean>;

  /**
   * DD-005 stage 3: rows left at `raw` or awaiting an embedding, **oldest first**.
   * Named `find`, not `claim`: it takes no lock, which is correct for a
   * single-process server but must not be mistaken for `for update skip locked`.
   *
   * The policy is a parameter rather than a constant here so it lives in
   * `config/budgets.ts` with the rest of the design budgets; the store enforces the
   * filter but does not own the numbers (DD-041).
   */
  findEnhancementBacklog(
    limit: number,
    policy: EnhancementRetryPolicy,
  ): Promise<readonly MemoryRecord[]>;

  /**
   * Increments `enhancement_attempts` and stamps `last_attempt_at` (DD-041). Called
   * whenever an enhancement pass leaves a row still needing work, which is what
   * eventually lifts a permanently-failing row out of the backlog rather than
   * letting it starve everything behind it.
   */
  recordEnhancementAttempt(id: string): Promise<void>;

  /**
   * DD-012's eligibility predicate, and nothing more: it selects, it never merges.
   *
   * **Age plus zero usage, never `importance`.** No tool writes `importance`, so
   * every row sits at the default and a predicate over it matches the entire corpus —
   * which is how the original design would have fed the whole database to an
   * unattended merge.
   *
   * Coldest first, so a truncated batch is the strongest candidates rather than an
   * arbitrary slice.
   */
  findCompactionCandidates(
    limit: number,
    policy: CompactionPolicy,
  ): Promise<readonly MemoryRecord[]>;

  /**
   * Stamps `last_attempt_at` **without** incrementing the counter (DD-045).
   *
   * An outage is not evidence against the row, so it costs no attempt — but the row
   * must still step aside. The backlog is oldest-first, and a row whose model call
   * times out (a long `raw_content` on a CPU-only box is enough, DD-028) would
   * otherwise be handed to every subsequent pass, abort each one, and starve
   * everything behind it forever. The stamp puts it behind its own backoff instead.
   */
  deferEnhancement(id: string): Promise<void>;
}

/** DD-012. Both numbers come from `config/budgets.ts`; the store only applies them. */
export interface CompactionPolicy {
  /** Days since the later of `created_at` and `last_recalled_at`. */
  readonly minAgeDays: number;
  /** A row at or above this `compaction_depth` is not eligible. */
  readonly maxDepth: number;
}

/** DD-045. Both numbers come from `config/budgets.ts`; the store only applies them. */
export interface EnhancementRetryPolicy {
  /** A row at or above this many failures leaves the backlog for good (DD-041). */
  readonly maxAttempts: number;
  /** A row waits `retryBaseMs * 2^attempts` after a failure before it is claimable. */
  readonly retryBaseMs: number;
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
  /** DD-041: failed-enhancement counter, the repair pass's starvation guard. */
  readonly enhancementAttempts: number;
  readonly lastAttemptAt: Date | null;
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

/**
 * Ordered best-first. Rank is *position*, and is deliberately not a field: RRF
 * derives it from the array index anyway, so storing it would create a second
 * source of truth that no query can be made to guarantee — a tie in `ts_rank_cd`
 * or a post-filter would silently disagree with the order.
 */
export interface RankedMemory {
  readonly memory: MemoryRecord;
  /** Raw cosine, from the semantic ranker only (DD-033). */
  readonly similarity?: number;
}
