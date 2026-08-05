import { describe, expect, it } from "vitest";

import { MAX_ENHANCEMENT_ATTEMPTS } from "../../src/config/budgets.js";
import { isStrataError } from "../../src/errors.js";
import { repairPass } from "../../src/jobs/repair.js";
import { remember } from "../../src/tools/remember.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";

describe("the repair pass (DD-005 stage 3)", () => {
  it("upgrades a row left raw by an earlier outage", async () => {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);
    expect(stored.status).toBe("raw");

    deps.ollama.setGenerateMode("ok");
    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, enhanced: 1, degraded: 0 });
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.status).toBe("compressed");
    expect(row?.needsEmbedding).toBe(false);
  });

  it("embeds a row that was compressed but never embedded", async () => {
    const deps = createFakeDeps({ ollama: { embed: "wrongDimensions" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);
    expect(deps.store.rows[0]?.needsEmbedding).toBe(true);

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
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    await remember({ content: "a decision worth keeping" }, deps);
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

  it("leaves a row raw and counts the attempt when the model is still down", async () => {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    const stored = await remember({ content: "a decision worth keeping" }, deps);

    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, enhanced: 0, degraded: 1 });
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    // One from remember's inline stage 2, one from this pass.
    expect(row?.enhancementAttempts).toBe(2);
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

  it("skips a row that needs nothing, without calling the model", async () => {
    const deps = createFakeDeps();
    deps.store.seed([{ id: "a", summary: "s", status: "raw", rawContent: null }]);

    const report = await repairPass(deps);

    expect(report).toMatchObject({ examined: 1, skipped: 1, degraded: 0 });
    expect(deps.ollama.generateCalls).toEqual([]);
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
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
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
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    deps.store.seed([
      { id: "poison", summary: "p", status: "raw", createdAt: new Date(1_000) },
      { id: "healthy", summary: "h", status: "raw", createdAt: new Date(2_000) },
    ]);

    for (let pass = 0; pass < MAX_ENHANCEMENT_ATTEMPTS; pass += 1) {
      await repairPass(deps, 1);
    }
    // The poison row is now capped out; only then can the healthy row be claimed.
    deps.ollama.setGenerateMode("ok");
    const report = await repairPass(deps, 1);

    expect(report.enhanced).toBe(1);
    expect(deps.store.rows.find((row) => row.id === "healthy")?.status).toBe("compressed");
    expect(deps.store.rows.find((row) => row.id === "poison")?.status).toBe("raw");
  });
});
