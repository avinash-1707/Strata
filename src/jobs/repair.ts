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
  readonly examined: number;
  readonly enhanced: number;
  readonly degraded: number;
  readonly skipped: number;
}

export async function repairPass(
  deps: ToolDeps,
  limit: number = REPAIR_BATCH_SIZE,
): Promise<RepairReport> {
  const backlog = await deps.store.findEnhancementBacklog(limit, MAX_ENHANCEMENT_ATTEMPTS);

  let enhanced = 0;
  let degraded = 0;
  let skipped = 0;

  // Sequential, not Promise.all: the target has one CPU-bound Ollama (DD-028), so
  // concurrent rows would queue inside it while also starving foreground calls.
  for (const record of backlog) {
    const { outcome } = await enhanceMemory(record, deps);
    if (outcome === "enhanced") {
      enhanced += 1;
    } else if (outcome === "degraded") {
      degraded += 1;
    } else {
      skipped += 1;
    }
  }

  const report = { examined: backlog.length, enhanced, degraded, skipped };

  // A steady stream of degraded rows means Ollama is failing and the corpus is
  // quietly filling with uncompressed memories. That must be visible.
  deps.log[degraded > 0 ? "warn" : "info"](report, "repair pass complete");

  return report;
}
