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
