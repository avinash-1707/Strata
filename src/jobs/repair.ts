import { MAX_ENHANCEMENT_ATTEMPTS, REPAIR_BATCH_SIZE } from "../config/budgets.js";
import type { ToolDeps } from "../deps.js";
import { enhanceMemory } from "../tools/enhance.js";

/**
 * DD-005 stage 3: drains rows left at `status='raw'` or `needs_embedding`.
 *
 * Idempotent by construction — it re-runs stage 2, and a fully enhanced row is no
 * longer in the backlog, so a second pass over the same corpus finds nothing to do.
 */
export interface RepairReport {
  /** Rows the pass actually processed, which is below the backlog size when it aborts. */
  readonly examined: number;
  readonly enhanced: number;
  readonly degraded: number;
  readonly skipped: number;
  /** DD-045: a transport failure ended the pass early, charging nothing to the row. */
  readonly aborted: boolean;
}

export async function repairPass(
  deps: ToolDeps,
  limit: number = REPAIR_BATCH_SIZE,
): Promise<RepairReport> {
  const backlog = await deps.store.findEnhancementBacklog(limit, MAX_ENHANCEMENT_ATTEMPTS);

  let examined = 0;
  let enhanced = 0;
  let degraded = 0;
  let skipped = 0;
  let aborted = false;

  // Sequential, not Promise.all: the target has one CPU-bound Ollama (DD-028), so
  // concurrent rows would queue inside it while also starving foreground calls.
  for (const record of backlog) {
    /* The per-call ceiling, NOT ENHANCEMENT_TIMEOUT_MS. That 5s bound exists because
       stage 2 runs inline on the write path with an agent waiting; nothing waits here.
       Reusing it on a CPU-only target, where a 3B generation legitimately takes tens
       of seconds (DD-028), would time out every compression, count an attempt, and
       within MAX_ENHANCEMENT_ATTEMPTS cycles cap out every row the pass exists to
       repair — and the counter is never reset (DD-041). */
    const { outcome } = await enhanceMemory(record, deps, deps.config.OLLAMA_TIMEOUT_MS);
    examined += 1;
    if (outcome === "enhanced") {
      enhanced += 1;
    } else if (outcome === "degraded") {
      degraded += 1;
    } else if (outcome === "deferred") {
      /* Ollama is down or too slow. Every remaining row would fail the same way, and
         DD-045 charges none of them for it — so continuing would only spend the
         batch's model budget proving the outage once per row. */
      aborted = true;
      break;
    } else {
      skipped += 1;
    }
  }

  const report = { examined, enhanced, degraded, skipped, aborted };

  // A degraded row means content the model cannot handle; an abort means the model
  // itself is unreachable. Both leave the corpus filling with uncompressed
  // memories, and neither surfaces anywhere else.
  deps.log[degraded > 0 || aborted ? "warn" : "info"](report, "repair pass complete");

  return report;
}
