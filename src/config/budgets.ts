/**
 * Time and size budgets that are properties of the *design*, not of the deployment.
 * Anything an operator should be able to change belongs in `env.ts` instead; putting
 * both in one module hid which was which.
 */

/**
 * The bound on DD-005 stage 2, deliberately far tighter than `OLLAMA_TIMEOUT_MS`.
 * Stage 2 runs inline on the write path *after* the memory is already durable, so a
 * slow model there should degrade to `status: 'raw'` and let the repair pass retry —
 * not hold the calling agent for a full minute over an enhancement it never needed
 * to wait for.
 */
export const ENHANCEMENT_TIMEOUT_MS = 5_000;

/**
 * The DD-005 stage 1 placeholder `summary`, read only before compression lands.
 * Raw content is indexed separately, so this is not a matching budget — just
 * enough to recognize a memory whose enhancement failed.
 */
export const RAW_SUMMARY_LENGTH = 500;

/**
 * Candidates per ranker before fusion. Well above the default `k` of 8 so RRF has
 * real disagreement to resolve, small enough to keep the synthesis prompt bounded.
 */
export const SEARCH_CANDIDATE_LIMIT = 20;

/**
 * Rows per repair run (DD-041). Each costs a compression *and* an embedding on a
 * CPU-only Ollama (DD-028), competing with foreground `remember` calls.
 */
export const REPAIR_BATCH_SIZE = 10;

/**
 * Attempts before the repair pass gives up on a row (DD-041). Without a cap,
 * content that always breaks compression holds its slot in the oldest-first
 * backlog forever — the starvation DD-032 item 3 names.
 */
export const MAX_ENHANCEMENT_ATTEMPTS = 5;

/**
 * Backoff base for a row the model could not handle: the backlog leaves it alone
 * for `base * 2^attempts` (DD-045). Without it, a row that fails on content burns
 * its whole cap in five consecutive minutes and is written off before an operator
 * could notice — and each of those retries costs a CPU-bound generation (DD-028).
 * One minute is the repair cadence, so a first failure waits about two passes and a
 * fourth waits sixteen.
 */
export const ENHANCEMENT_RETRY_BASE_MS = 60_000;

export const ENHANCEMENT_RETRY_POLICY = {
  maxAttempts: MAX_ENHANCEMENT_ATTEMPTS,
  retryBaseMs: ENHANCEMENT_RETRY_BASE_MS,
} as const;

/**
 * Cadence of DD-005 stage 3. Frequent enough that a degraded write waits about a
 * minute for its retry, rare enough that repair's CPU-bound model calls do not
 * compete with foreground `remember` traffic on a box with no GPU (DD-028).
 */
export const REPAIR_INTERVAL_MS = 60_000;

/**
 * Recall cache entry lifetime (DD-010). Correctness never depends on this —
 * version-scoped keys make stale entries unreachable — so it only bounds how long
 * an unreachable generation occupies Redis memory, while staying long enough for
 * the repeat reads that make the cache worth having on a CPU-bound box (DD-028).
 */
export const RECALL_CACHE_TTL_SECONDS = 300;

/**
 * How long a hung close gets before the process exits anyway. Past this, waiting is
 * worse than a non-zero exit: the container never stops and the orchestrator SIGKILLs
 * it, which is the same outcome with no log line explaining it.
 */
export const SHUTDOWN_FLOOR_MS = 5_000;

/**
 * How long an HTTP connection still open at shutdown gets before it is severed.
 *
 * Node 19+ closes *idle* keep-alive sockets itself, so this is about a request in
 * flight: `close()` waits for those forever, and the slowest Strata handler calls a
 * CPU-bound model. Derived rather than written as a literal because the two constants
 * are coupled and read like independent choices — a drain at or above the floor means
 * the watchdog fires *during* teardown, killing the process at the one moment the
 * write path is most exposed. The remaining budget covers a repair pass in progress
 * plus the pg and Redis closes.
 */
export const CONNECTION_DRAIN_MS = Math.round(SHUTDOWN_FLOOR_MS * 0.4);
