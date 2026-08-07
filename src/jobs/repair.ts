import { ENHANCEMENT_RETRY_POLICY, REPAIR_BATCH_SIZE } from "../config/budgets.js";
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
  /* Shutdown. Without it a pass runs to completion holding the advisory lock's pooled
     connection through up to REPAIR_BATCH_SIZE CPU-bound model calls, `pool.end()`
     waits behind that connection, and the shutdown floor turns every deploy into a
     non-zero exit — which is the one alarm the shutdown path owns. */
  signal?: AbortSignal,
): Promise<RepairReport> {
  const backlog = await deps.store.findEnhancementBacklog(limit, ENHANCEMENT_RETRY_POLICY);

  let examined = 0;
  let enhanced = 0;
  let degraded = 0;
  let skipped = 0;
  let aborted = false;

  // Sequential, not Promise.all: the target has one CPU-bound Ollama (DD-028), so
  // concurrent rows would queue inside it while also starving foreground calls.
  for (const record of backlog) {
    if (signal?.aborted === true) {
      // Nothing is charged or stamped: a row never shown to the model taught us
      // nothing about it, and the next pass should pick it up unpenalized (DD-045).
      break;
    }

    /* The per-call ceiling, NOT ENHANCEMENT_TIMEOUT_MS. That 5s bound exists because
       stage 2 runs inline on the write path with an agent waiting; nothing waits here.
       Reusing it on a CPU-only target, where a 3B generation legitimately takes tens
       of seconds (DD-028), would time out every compression, count an attempt, and
       within MAX_ENHANCEMENT_ATTEMPTS cycles cap out every row the pass exists to
       repair — and the counter is never reset (DD-041). */
    const { outcome } = await enhanceMemory(
      record,
      deps,
      deps.config.OLLAMA_TIMEOUT_MS,
      signal,
    );
    examined += 1;
    if (outcome === "enhanced") {
      enhanced += 1;
    } else if (outcome === "degraded") {
      degraded += 1;
    } else if (outcome === "skipped") {
      skipped += 1;
    } else {
      /* Ollama is down or too slow. Every remaining row would fail the same way, and
         DD-045 charges none of them for it — so continuing would only spend the
         batch's model budget proving the outage once per row. The deferred row was
         stamped, so the next pass steps over it rather than repeating this. */
      // The annotation is a compile-time exhaustiveness check: a fifth outcome fails
      // to assign here rather than being silently absorbed by this branch.
      const deferred: "deferred" = outcome;
      deps.log.debug({ id: record.id, outcome: deferred }, "repair pass stopped on this row");
      aborted = true;
      break;
    }
  }

  const report = { examined, enhanced, degraded, skipped, aborted };

  if (signal?.aborted === true) {
    /* Not the warn below. A cancelled call arrives as OLLAMA_UNAVAILABLE and sets
       `aborted`, so shutdown would otherwise warn about a model outage on every
       deploy — and send an operator looking for one. */
    deps.log.debug(report, "repair pass stopped for shutdown");
    return report;
  }

  // A degraded row means content the model cannot handle; an abort means the model
  // itself is unreachable. Both leave the corpus filling with uncompressed
  // memories, and neither surfaces anywhere else.
  deps.log[degraded > 0 || aborted ? "warn" : "info"](report, "repair pass complete");

  return report;
}
