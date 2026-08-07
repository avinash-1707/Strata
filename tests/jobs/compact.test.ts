import { describe, expect, it } from "vitest";

import { COMPACTION_MAX_DEPTH } from "../../src/config/budgets.js";
import { compactionDryRun } from "../../src/jobs/compact.js";
import type { CompactionPolicy, MemoryStore } from "../../src/store/types.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import type { SeedMemory } from "../fakes/fakeStore.js";

/** Admits every seeded row, so these cases are about the job, not the predicate. */
const ANY_AGE: CompactionPolicy = { minAgeDays: 0, maxDepth: COMPACTION_MAX_DEPTH };

const COLD: readonly SeedMemory[] = [
  { id: "00000000-0000-4000-8000-000000000001", summary: "an old note about the pool" },
  { id: "00000000-0000-4000-8000-000000000002", summary: "an old note about the cache" },
];

/** Everything a compaction pass could possibly use to change the corpus. */
const WRITES: readonly (keyof MemoryStore)[] = [
  "insertRaw",
  "applyEnhancement",
  "softDelete",
  "restore",
  "touchUsage",
  "recordEnhancementAttempt",
  "deferEnhancement",
];

describe("the compaction dry run (DD-012)", () => {
  it("reports the eligible memories in reviewable form", async () => {
    const deps = createFakeDeps({ store: { rows: COLD } });

    const report = await compactionDryRun(deps, 10, ANY_AGE);

    expect(report.candidates.map((candidate) => candidate.id)).toEqual(
      COLD.map((row) => row.id),
    );
    expect(report.candidates[0]).toMatchObject({
      summary: "an old note about the pool",
      recallCount: 0,
      compactionDepth: 0,
      lastRecalledAt: null,
    });
    // ISO, not a Date: the report is read out of a log line.
    expect(() => new Date(report.candidates[0]?.createdAt ?? "").toISOString()).not.toThrow();
  });

  /* The whole point of a dry run, and the one property that must never regress: the
     next phase adds a merge to this function, and this is what says it did not arrive
     early. */
  it("writes nothing at all", async () => {
    const deps = createFakeDeps({ store: { rows: COLD } });

    await compactionDryRun(deps, 10, ANY_AGE);

    expect(deps.store.calls).toEqual(["findCompactionCandidates"]);
    for (const write of WRITES) {
      expect(deps.store.calls).not.toContain(write);
    }
  });

  it("never calls the model — selection is a database question", async () => {
    const deps = createFakeDeps({ store: { rows: COLD } });

    await compactionDryRun(deps, 10, ANY_AGE);

    expect(deps.ollama.generateCalls).toEqual([]);
    expect(deps.ollama.embedCalls).toEqual([]);
  });

  it("flags a full batch, so a reviewer does not read a page as a total", async () => {
    const deps = createFakeDeps({ store: { rows: COLD } });

    await expect(compactionDryRun(deps, 2, ANY_AGE)).resolves.toMatchObject({ truncated: true });
    await expect(compactionDryRun(deps, 3, ANY_AGE)).resolves.toMatchObject({ truncated: false });
  });

  it("reports an empty corpus as nothing to do, not as a failure", async () => {
    const deps = createFakeDeps();

    await expect(compactionDryRun(deps, 10, ANY_AGE)).resolves.toEqual({
      candidates: [],
      truncated: false,
    });
  });
});
