import { COMPACTION_BATCH_SIZE, COMPACTION_POLICY } from "../config/budgets.js";
import type { ToolDeps } from "../deps.js";
import type { CompactionPolicy, MemoryRecord } from "../store/types.js";

/**
 * DD-012's mandatory dry run: the only part of compaction that exists yet, and the
 * only part that can exist before a model has been measured.
 *
 * **It selects and reports. It does not group, merge, or write.** Deciding *which*
 * candidates belong together needs a near-duplicate threshold, and that threshold is
 * still open (DD-023) — picking one here would bury an unmeasured guess inside the
 * one component that destroys information unattended. Phase 11 adds the grouping and
 * the merge on top of this selection, against a stubbed model (DD-024).
 *
 * Deliberately **not** gated on `COMPACTION_ENABLED`. The flag arms execution; a run
 * that writes nothing is how an operator decides whether to set it, so requiring the
 * flag to see the output would invert the review this exists for.
 */

/** A candidate as a reviewer needs to see it: enough to judge, nothing internal. */
export interface CompactionCandidate {
  readonly id: string;
  readonly summary: string;
  readonly tags: readonly string[];
  /** ISO 8601, so the report is readable in a log line without a formatter. */
  readonly createdAt: string;
  readonly lastRecalledAt: string | null;
  readonly recallCount: number;
  readonly compactionDepth: number;
}

export interface CompactionDryRunReport {
  readonly candidates: readonly CompactionCandidate[];
  /**
   * The batch filled up, so there are probably more. Reported because a reviewer
   * judging "compaction would touch 50 memories" needs to know when that 50 is a
   * page rather than a total.
   */
  readonly truncated: boolean;
}

export async function compactionDryRun(
  deps: ToolDeps,
  limit: number = COMPACTION_BATCH_SIZE,
  policy: CompactionPolicy = COMPACTION_POLICY,
): Promise<CompactionDryRunReport> {
  const candidates = await deps.store.findCompactionCandidates(limit, policy);

  const report: CompactionDryRunReport = {
    candidates: candidates.map(toCandidate),
    truncated: candidates.length === limit,
  };

  deps.log.info(
    {
      job: "compaction",
      dryRun: true,
      eligible: report.candidates.length,
      truncated: report.truncated,
      minAgeDays: policy.minAgeDays,
      maxDepth: policy.maxDepth,
    },
    "compaction dry run complete, nothing written",
  );

  return report;
}

function toCandidate(record: MemoryRecord): CompactionCandidate {
  return {
    id: record.id,
    summary: record.summary,
    tags: [...record.tags],
    createdAt: record.createdAt.toISOString(),
    lastRecalledAt: record.lastRecalledAt?.toISOString() ?? null,
    recallCount: record.recallCount,
    compactionDepth: record.compactionDepth,
  };
}
