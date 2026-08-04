/**
 * The agent-facing wire contracts. This module imports nothing so that every
 * layer can depend on it without creating a cycle (coding-standards §4).
 *
 * Field names here are `snake_case` because they are public API: they cross the
 * MCP boundary exactly as written and the `camelCase` convention stops at that
 * boundary (§9). Internal types must not reuse these shapes.
 */

/** DD-018: every input and output is declared. Gaps get filled by guessing. */
export interface RememberInput {
  readonly content: string;
  readonly tags?: readonly string[];
  readonly session_id?: string;
}

/** DD-005: `status` lets a caller tell a compressed memory from a durable raw one. */
export type MemoryStatus = "raw" | "compressed";

export interface RememberOutput {
  readonly id: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly status: MemoryStatus;
}

export interface RecallInput {
  readonly query: string;
  readonly k?: number;
  readonly synthesize?: boolean;
  readonly session_id?: string;
}

export interface RecallResult {
  readonly id: string;
  readonly summary: string;
  readonly tags: readonly string[];
  /** RRF score. Ordinal only — never compare across queries or threshold (DD-016). */
  readonly score: number;
  /**
   * Raw cosine similarity, present only when the semantic ranker contributed
   * this hit. A lexical-only hit has no cosine, and inventing one would make an
   * ordinal-only signal look absolute (DD-033).
   */
  readonly similarity?: number;
}

export interface RecallOutput {
  /** Present iff `synthesize` was true and synthesis succeeded (DD-005). */
  readonly answer?: string;
  readonly results: readonly RecallResult[];
}

export type TagMatch = "any" | "all";

export interface SearchByTagInput {
  readonly tags: readonly string[];
  readonly match?: TagMatch;
  readonly limit?: number;
}

export interface SearchByTagResult {
  readonly id: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly created_at: string;
}

export interface SearchByTagOutput {
  readonly results: readonly SearchByTagResult[];
}

export interface ForgetInput {
  readonly id: string;
}

/** DD-018: `false` distinguishes "no such id" from a successful delete. */
export interface ForgetOutput {
  readonly deleted: boolean;
}

/** `recall`'s default result count. Eight fits an agent's context budget. */
export const DEFAULT_RECALL_K = 8;

/** Upper bound on `recall`'s `k`. Beyond this, synthesis input stops fitting. */
export const MAX_RECALL_K = 50;

/** `search_by_tag`'s default page size. */
export const DEFAULT_TAG_LIMIT = 20;

/** Upper bound on `search_by_tag`'s `limit`. */
export const MAX_TAG_LIMIT = 200;
