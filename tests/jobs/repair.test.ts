import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENHANCEMENT_RETRY_BASE_MS,
  ENHANCEMENT_TIMEOUT_MS,
  MAX_ENHANCEMENT_ATTEMPTS,
} from "../../src/config/budgets.js";
import { isStrataError } from "../../src/errors.js";
import { repairPass } from "../../src/jobs/repair.js";
import { remember } from "../../src/tools/remember.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import { until } from "../support/until.js";

/**
 * A failed row is not claimable again until `base · 2^attempts` of wall clock has
 * passed (DD-045), so back-to-back passes see an empty backlog. Tests that need the
 * *next* pass move the clock instead of sleeping through the real interval.
 */
function skipBackoff(): void {
  vi.advanceTimersByTime(ENHANCEMENT_RETRY_BASE_MS * 2 ** MAX_ENHANCEMENT_ATTEMPTS);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the repair pass (DD-005 stage 3)", () => {
  it("upgrades a row left raw by an earlier outage", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);
    expect(stored.status).toBe("raw");

    // The failed write stamped the row, so it is waiting out one backoff (DD-045).
    skipBackoff();
    deps.ollama.setGenerateMode("ok");
    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, enhanced: 1, degraded: 0 });
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.status).toBe("compressed");
    expect(row?.needsEmbedding).toBe(false);
  });

  it("embeds a row that was compressed but never embedded", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps({ ollama: { embed: "wrongDimensions" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);
    expect(deps.store.rows[0]?.needsEmbedding).toBe(true);

    // A wrong-width vector is a content failure, so the row is serving a backoff.
    skipBackoff();
    deps.ollama.setEmbedMode("ok");
    const report = await repairPass(deps);

    expect(report.enhanced).toBe(1);
    // Re-embedding must not re-compress: the summary is already the compressed one.
    expect(deps.ollama.generateCalls).toHaveLength(1);
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.needsEmbedding).toBe(false);
  });

  /* "Safe to run repeatedly" is the whole contract: a fully enhanced row leaves the
     backlog, so a second pass has nothing to do. */
  it("is idempotent across two runs", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    await remember({ content: "a decision worth keeping" }, deps);
    skipBackoff();
    deps.ollama.setGenerateMode("ok");

    const first = await repairPass(deps);
    const generateCallsAfterFirst = deps.ollama.generateCalls.length;
    const second = await repairPass(deps);

    expect(first.enhanced).toBe(1);
    expect(second).toMatchObject({ examined: 0, enhanced: 0, degraded: 0 });
    expect(deps.ollama.generateCalls).toHaveLength(generateCallsAfterFirst);
  });

  it("does nothing on an empty backlog", async () => {
    const deps = createFakeDeps();

    await expect(repairPass(deps)).resolves.toMatchObject({ examined: 0, enhanced: 0 });
  });

  it("leaves a row raw and counts the attempt when the content defeats the model", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps({ ollama: { generate: "wrongFields" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);

    skipBackoff();
    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, enhanced: 0, degraded: 1, aborted: false });
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    // One from remember's inline stage 2, one from this pass.
    expect(row?.enhancementAttempts).toBe(2);
  });

  /* The compounding defect DD-045 exists to close: with the model down, the old pass
     charged an attempt to every row in the batch, so five minutes of outage stranded
     a whole session's writes at status:'raw' permanently. */
  it("stops the pass and charges nothing when the model is unreachable (DD-045)", async () => {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    deps.store.seed([
      { id: "a", summary: "a", status: "raw", createdAt: new Date(1_000) },
      { id: "b", summary: "b", status: "raw", createdAt: new Date(2_000) },
      { id: "c", summary: "c", status: "raw", createdAt: new Date(3_000) },
    ]);

    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, enhanced: 0, degraded: 0, aborted: true });
    // Not just the row it stopped on: the rows behind it were never touched either.
    expect(deps.store.rows.map((row) => row.enhancementAttempts)).toEqual([0, 0, 0]);
    expect(deps.store.rows.map((row) => row.lastAttemptAt === null)).toEqual([false, true, true]);
    expect(deps.ollama.generateCalls).toHaveLength(1);
  });

  /* One row whose generation times out looks exactly like a global outage — same
     error code — but must not be able to abort every pass forever. The deferral stamp
     is what puts it behind a backoff so the next pass reaches the rows behind it
     (DD-045). Without the stamp this loops on "poison" until the process dies. */
  it("reaches the rows behind a row that always times out", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps();
    deps.ollama.timeOutOn("poison");
    deps.store.seed([
      { id: "slow", summary: "s", status: "raw", rawContent: "poison", createdAt: new Date(1_000) },
      { id: "healthy", summary: "h", status: "raw", createdAt: new Date(2_000) },
    ]);

    const first = await repairPass(deps, 1);
    // Uncounted, but stamped — that is the whole difference.
    const slow = deps.store.rows.find((row) => row.id === "slow");
    expect(first).toMatchObject({ examined: 1, aborted: true });
    expect(slow?.enhancementAttempts).toBe(0);
    expect(slow?.lastAttemptAt).toBeInstanceOf(Date);

    // The next pass, still inside the slow row's backoff window.
    const second = await repairPass(deps, 1);

    expect(second).toMatchObject({ examined: 1, enhanced: 1, aborted: false });
    expect(deps.store.rows.find((row) => row.id === "healthy")?.status).toBe("compressed");
  });

  it("resumes at full strength once the model is back", async () => {
    vi.useFakeTimers();
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    deps.store.seed([{ id: "a", summary: "a", status: "raw" }]);

    await repairPass(deps);
    skipBackoff();
    deps.ollama.setGenerateMode("ok");
    const second = await repairPass(deps);

    expect(second).toMatchObject({ examined: 1, enhanced: 1, aborted: false });
    expect(deps.store.rows[0]?.enhancementAttempts).toBe(0);
  });

  it("takes the oldest rows first", async () => {
    const deps = createFakeDeps();
    deps.store.seed([
      { id: "new", summary: "n", status: "raw", createdAt: new Date(3_000) },
      { id: "old", summary: "o", status: "raw", createdAt: new Date(1_000) },
      { id: "mid", summary: "m", status: "raw", createdAt: new Date(2_000) },
    ]);

    await repairPass(deps, 2);

    const compressed = deps.store.rows
      .filter((row) => row.status === "compressed")
      .map((row) => row.id);
    expect(compressed.sort()).toEqual(["mid", "old"]);
  });

  it("honors its batch size", async () => {
    const deps = createFakeDeps();
    deps.store.seed([
      { id: "a", summary: "a", status: "raw" },
      { id: "b", summary: "b", status: "raw" },
      { id: "c", summary: "c", status: "raw" },
    ]);

    await expect(repairPass(deps, 2)).resolves.toMatchObject({ examined: 2 });
  });

  /* Counted as degraded, not skipped, and the attempt is recorded — because the
     backlog matches on status='raw' and this row would otherwise match forever,
     holding a slot in every pass. */
  it("counts an unrepairable row against its attempts so it eventually leaves", async () => {
    const deps = createFakeDeps();
    deps.store.seed([{ id: "a", summary: "s", status: "raw", rawContent: null }]);

    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, degraded: 1, skipped: 0 });
    expect(deps.ollama.generateCalls).toEqual([]);
    expect(deps.store.rows[0]?.enhancementAttempts).toBe(1);
  });

  it("stops claiming an unrepairable row once it caps out", async () => {
    const deps = createFakeDeps();
    deps.store.seed([{ id: "a", summary: "s", status: "raw", rawContent: null }]);

    for (let pass = 0; pass < MAX_ENHANCEMENT_ATTEMPTS; pass += 1) {
      await repairPass(deps);
    }

    await expect(repairPass(deps)).resolves.toMatchObject({ examined: 0 });
  });

  /* DD-010. The pass rewrites summaries and adds vectors, so a recall cached before it
     ran is stale in both its text and its result set. Nothing else bumps for it: the
     pass has no insert in front of it. */
  it("bumps the corpus version after upgrading a row", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 5 } });
    deps.store.seed([{ id: "a", summary: "s", status: "raw" }]);

    await repairPass(deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(6);
  });

  it("does not bump when it repaired nothing", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 5 } });

    await repairPass(deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(5);
  });

  it("repairs even when a generation takes longer than the write-path budget", async () => {
    /* The pass must not inherit ENHANCEMENT_TIMEOUT_MS. That 5s bound exists because
       stage 2 blocks an agent; nothing waits on the repair pass, and on a CPU-only
       target a real generation legitimately exceeds it (DD-028). */
    const deps = createFakeDeps({ config: { OLLAMA_TIMEOUT_MS: 45_000 } });
    deps.store.seed([{ id: "a", summary: "s", status: "raw" }]);

    await repairPass(deps);

    const budgets = deps.ollama.generateCalls.map((call) => call.options?.timeoutMs);
    expect(budgets[0]).toBe(45_000);
    expect(budgets[0]).not.toBe(ENHANCEMENT_TIMEOUT_MS);
  });

  it("fails when Postgres is down — the backlog query is not optional", async () => {
    const deps = createFakeDeps({ store: { down: true } });

    await expect(repairPass(deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
  });
});

describe("the repair pass cannot be starved by a poison row (DD-041)", () => {
  it("stops claiming a row once it has exhausted its attempts", async () => {
    const deps = createFakeDeps({ ollama: { generate: "wrongFields" } });
    deps.store.seed([
      { id: "poison", summary: "p", status: "raw", enhancementAttempts: MAX_ENHANCEMENT_ATTEMPTS },
    ]);

    await expect(repairPass(deps)).resolves.toMatchObject({ examined: 0 });
  });

  /* Without the cap, a row that always fails sits at the head of the oldest-first
     backlog forever, and once a batch of them accumulates the pass reaches nothing
     else. This is that scenario in miniature: batch size 1, one poison row that is
     older than the row behind it. */
  it("eventually reaches a healthy row queued behind a permanently failing one", async () => {
    vi.useFakeTimers();
    // A content failure, because only content is charged against the cap (DD-045):
    // an unreachable model would abort each pass instead of capping the poison row.
    const deps = createFakeDeps({ ollama: { generate: "wrongFields" } });
    deps.store.seed([
      { id: "poison", summary: "p", status: "raw", createdAt: new Date(1_000) },
      { id: "healthy", summary: "h", status: "raw", createdAt: new Date(2_000) },
    ]);

    for (let pass = 0; pass < MAX_ENHANCEMENT_ATTEMPTS; pass += 1) {
      await repairPass(deps, 1);
      skipBackoff();
    }
    // The poison row is now capped out; only then can the healthy row be claimed.
    deps.ollama.setGenerateMode("ok");
    const report = await repairPass(deps, 1);

    expect(report.enhanced).toBe(1);
    expect(deps.store.rows.find((row) => row.id === "healthy")?.status).toBe("compressed");
    expect(deps.store.rows.find((row) => row.id === "poison")?.status).toBe("raw");
  });
});

describe("the repair pass yields to shutdown (DD-045)", () => {
  /** Rows left raw by an outage, all waiting in the backlog. */
  async function backlogOf(count: number): Promise<ReturnType<typeof createFakeDeps>> {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    for (let i = 0; i < count; i += 1) {
      await remember({ content: `memory number ${String(i)}` }, deps);
    }
    skipBackoff();
    deps.ollama.setGenerateMode("ok");
    return deps;
  }

  it("examines nothing when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const deps = await backlogOf(3);
    const controller = new AbortController();
    controller.abort();

    const before = deps.store.calls.length;
    const report = await repairPass(deps, 10, controller.signal);

    expect(report.examined).toBe(0);
    // Charging a row never shown to the model would spend its cap on our shutdown.
    expect(deps.store.calls.slice(before)).not.toContain("recordEnhancementAttempt");
  });

  /* The point is the *connection*: a pass that runs its whole batch holds the advisory
     lock's pooled client through that many CPU-bound model calls, and pool.end() waits
     behind it until the shutdown floor kills the process. */
  it("stops between rows once the signal aborts mid-pass", async () => {
    vi.useFakeTimers();
    const deps = await backlogOf(4);
    const controller = new AbortController();

    // Blocked on the first row's write, so the abort lands provably mid-pass rather
    // than on a timing guess.
    const release = deps.store.block("applyEnhancement");
    const pass = repairPass(deps, 10, controller.signal);
    await until(
      () => deps.store.calls.includes("applyEnhancement"),
      "the first row reached its write",
    );

    controller.abort();
    release();
    const report = await pass;

    expect(report.examined).toBe(1);
    expect(report.enhanced).toBe(1);
  });

  it("runs the whole backlog when nothing aborts", async () => {
    vi.useFakeTimers();
    const deps = await backlogOf(4);

    const report = await repairPass(deps, 10, new AbortController().signal);

    expect(report.examined).toBe(4);
  });
});
