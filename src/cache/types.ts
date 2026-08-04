import type { RecallOutput } from "../contracts.js";

/**
 * The cache seam. Redis holds nothing durable: flushing it must cost latency
 * only, never data, and every read path must work with Redis entirely absent.
 */
export interface Cache {
  getCorpusVersion(): Promise<number>;

  /** DD-010: `INCR`d by every mutation, which is what makes stale keys unreachable. */
  bumpCorpusVersion(): Promise<void>;

  getRecall(corpusVersion: number, key: RecallKey): Promise<RecallOutput | undefined>;

  setRecall(corpusVersion: number, key: RecallKey, value: RecallOutput): Promise<void>;

  close(): Promise<void>;
}

/**
 * The semantic parts of a recall cache key, not a pre-hashed string. The cache
 * owns normalization, hashing, and key composition so that DD-010's two bugs are
 * unreachable by construction rather than by review: `k=8` cannot collide with
 * `k=50`, and a `synthesize: false` call cannot be served a cached `answer`.
 */
export interface RecallKey {
  /** Raw query. Normalization (trim, collapse whitespace, lowercase) is the cache's job. */
  readonly query: string;
  readonly k: number;
  readonly synthesize: boolean;
  readonly sessionId?: string;
}

/**
 * `corpusVersion` is an explicit parameter on both get and set, and a single
 * recall must pass the same value to both. If `setRecall` re-read the version
 * itself, a mutation landing between the read and the write would store
 * pre-mutation results under the post-mutation key — resurrecting exactly the
 * stale entry DD-010 exists to make unreachable.
 */
export type CorpusVersion = number;
