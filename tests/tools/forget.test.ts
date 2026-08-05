import { describe, expect, it } from "vitest";

import { DEFAULT_RECALL_K } from "../../src/contracts/recall.js";
import { StrataError, isStrataError } from "../../src/errors.js";
import { forget, restore } from "../../src/tools/forget.js";
import { recall } from "../../src/tools/recall.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import { createRecordingLogger } from "../support/recordingLogger.js";
import type { RecordingLogger } from "../support/recordingLogger.js";

function withLog(options: FakeDepsOptions = {}): { deps: FakeDeps; log: RecordingLogger } {
  const log = createRecordingLogger();
  return { deps: createFakeDeps({ ...options, log }), log };
}

const ASK = { query: "postgres pool", k: DEFAULT_RECALL_K, synthesize: false } as const;

describe("forget: a soft delete (DD-012)", () => {
  it("retains the row and stamps deleted_at rather than removing it", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "s" }] } });

    const result = await forget({ id: "a" }, deps);

    expect(result.deleted).toBe(true);
    // Retained, which is what makes restore possible and bounds the blast radius.
    expect(deps.store.rows).toHaveLength(1);
    expect(deps.store.rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("reports false for an unknown id instead of failing", async () => {
    const deps = createFakeDeps();

    await expect(forget({ id: "nope" }, deps)).resolves.toEqual({ deleted: false });
  });

  it("reports false on a second call — deleting twice is not two deletions", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "s" }] } });

    await forget({ id: "a" }, deps);

    await expect(forget({ id: "a" }, deps)).resolves.toEqual({ deleted: false });
  });

  it("bumps the corpus version so cached recalls become unreachable (DD-010)", async () => {
    const deps = createFakeDeps({
      store: { rows: [{ id: "a", summary: "s" }] },
      cache: { initialVersion: 3 },
    });

    await forget({ id: "a" }, deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(4);
  });

  it("does not bump the version for an unknown id — nothing changed", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 3 } });

    await forget({ id: "nope" }, deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(3);
  });

  it("fails when Postgres is down", async () => {
    const deps = createFakeDeps({ store: { down: true } });

    await expect(forget({ id: "a" }, deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
  });

  it("deletes and warns when Redis is down", async () => {
    const { deps, log } = withLog({
      store: { rows: [{ id: "a", summary: "s" }] },
      cache: { down: true },
    });

    await expect(forget({ id: "a" }, deps)).resolves.toEqual({ deleted: true });
    expect(log.messages("warn")).toContain(
      "corpus version bump failed, cached recalls may be stale",
    );
  });
});

describe("forget then recall cannot return the forgotten memory", () => {
  it("misses the cached entry and excludes the row from a fresh search", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "postgres pool" }] } });

    const before = await recall(ASK, deps);
    expect(before.results.map((result) => result.id)).toEqual(["a"]);

    await forget({ id: "a" }, deps);
    const after = await recall(ASK, deps);

    expect(after.results).toEqual([]);
    // The pre-delete entry is still in Redis; the version bump is what makes its key
    // unreachable, so this must be a miss rather than a hit.
    expect(deps.cache.hits).toBe(0);
    expect(deps.cache.keys).toHaveLength(2);
  });

  /* The documented cost of a Redis outage: without the bump the stale entry stays
     reachable. Asserting it keeps the degradation honest instead of implied. */
  it("can still serve the forgotten memory from cache when the bump failed", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "postgres pool" }] } });
    await recall(ASK, deps);

    deps.cache.setFailure("bumpCorpusVersion", new StrataError("CACHE_UNAVAILABLE", "boom"));
    await forget({ id: "a" }, deps);

    const after = await recall(ASK, deps);
    expect(after.results.map((result) => result.id)).toEqual(["a"]);
    expect(deps.cache.hits).toBe(1);
  });
});

describe("restore: the inverse of forget (DD-039)", () => {
  it("makes a forgotten memory visible again", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "postgres pool" }] } });
    await forget({ id: "a" }, deps);

    const result = await restore({ id: "a" }, deps);

    expect(result.restored).toBe(true);
    const after = await recall(ASK, deps);
    expect(after.results.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("bumps the corpus version, since a cached recall that omitted the row is stale", async () => {
    const deps = createFakeDeps({
      store: { rows: [{ id: "a", summary: "s" }] },
      cache: { initialVersion: 1 },
    });

    await forget({ id: "a" }, deps);
    await restore({ id: "a" }, deps);

    // Two mutations, two bumps.
    await expect(deps.cache.getCorpusVersion()).resolves.toBe(3);
  });

  it("does not serve a stale post-forget recall after a restore", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "postgres pool" }] } });
    await forget({ id: "a" }, deps);
    const whileDeleted = await recall(ASK, deps);
    expect(whileDeleted.results).toEqual([]);

    await restore({ id: "a" }, deps);
    const afterRestore = await recall(ASK, deps);

    expect(afterRestore.results.map((hit) => hit.id)).toEqual(["a"]);
    expect(deps.cache.hits).toBe(0);
  });

  it("reports false for a memory that was never deleted", async () => {
    const deps = createFakeDeps({ store: { rows: [{ id: "a", summary: "s" }] } });

    await expect(restore({ id: "a" }, deps)).resolves.toEqual({ restored: false });
  });

  it("reports false for an unknown id", async () => {
    const deps = createFakeDeps();

    await expect(restore({ id: "nope" }, deps)).resolves.toEqual({ restored: false });
  });

  it("does not bump the version when there was nothing to restore", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 3 } });

    await restore({ id: "nope" }, deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(3);
  });

  /* Resurrecting a compaction input would duplicate content its merged replacement
     already covers (DD-012), so superseded rows are not restorable at all. */
  it("refuses a superseded row even when it is also deleted", async () => {
    const deps = createFakeDeps({
      store: {
        rows: [
          { id: "merged", summary: "s", supersededBy: "winner", deletedAt: new Date() },
          { id: "winner", summary: "s" },
        ],
      },
    });

    await expect(restore({ id: "merged" }, deps)).resolves.toEqual({ restored: false });
    expect(deps.store.rows.find((row) => row.id === "merged")?.deletedAt).not.toBeNull();
  });

  it("fails when Postgres is down", async () => {
    const deps = createFakeDeps({ store: { down: true } });

    await expect(restore({ id: "a" }, deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
  });

  it("restores and warns when Redis is down", async () => {
    const { deps, log } = withLog({ store: { rows: [{ id: "a", summary: "s" }] } });
    await forget({ id: "a" }, deps);
    deps.cache.setDown(true);

    await expect(restore({ id: "a" }, deps)).resolves.toEqual({ restored: true });
    expect(log.messages("warn")).toContain(
      "corpus version bump failed, cached recalls may be stale",
    );
  });
});
