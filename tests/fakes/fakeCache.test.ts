import { describe, expect, it } from "vitest";

import { composeRecallKey } from "../../src/cache/key.js";
import type { RecallKey } from "../../src/cache/types.js";
import type { RecallOutput } from "../../src/contracts.js";
import { isStrataError, StrataError } from "../../src/errors.js";
import { createFakeCache } from "./fakeCache.js";

const key: RecallKey = { query: "how does auth work", k: 8, synthesize: true };
const value: RecallOutput = { answer: "it uses a token", results: [] };

function codeOf(error: unknown): string {
  return isStrataError(error) ? error.code : "NOT_A_STRATA_ERROR";
}

describe("fake cache: round trip", () => {
  it("misses before a write and hits after", async () => {
    const cache = createFakeCache();
    const version = await cache.getCorpusVersion();

    await expect(cache.getRecall(version, key)).resolves.toBeUndefined();
    await cache.setRecall(version, key, value);
    await expect(cache.getRecall(version, key)).resolves.toEqual(value);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("exposes the composed key, matching the shared builder", async () => {
    const cache = createFakeCache({ initialVersion: 4 });
    await cache.setRecall(4, key, value);
    expect(cache.keys).toEqual([composeRecallKey(4, key)]);
  });
});

describe("fake cache: corpus versioning (DD-010)", () => {
  it("makes every prior entry unreachable on a bump", async () => {
    const cache = createFakeCache();
    const before = await cache.getCorpusVersion();
    await cache.setRecall(before, key, value);

    await cache.bumpCorpusVersion();
    const after = await cache.getCorpusVersion();

    expect(after).toBe(before + 1);
    await expect(cache.getRecall(after, key)).resolves.toBeUndefined();
  });

  /* The exact defect DD-010 closes: a forget followed by an identical recall used
     to be served the deleted memory, possibly buried inside a synthesized answer
     where its provenance was invisible. */
  it("does not serve a pre-mutation entry after a mutation", async () => {
    const cache = createFakeCache();
    const v1 = await cache.getCorpusVersion();
    await cache.setRecall(v1, key, { results: [{ id: "doomed", summary: "s", tags: [], score: 1 }] });

    await cache.bumpCorpusVersion();
    const v2 = await cache.getCorpusVersion();

    await expect(cache.getRecall(v2, key)).resolves.toBeUndefined();
  });

  it("separates entries differing only in k or synthesize", async () => {
    const cache = createFakeCache();
    const version = await cache.getCorpusVersion();
    await cache.setRecall(version, key, value);

    await expect(cache.getRecall(version, { ...key, k: 50 })).resolves.toBeUndefined();
    await expect(cache.getRecall(version, { ...key, synthesize: false })).resolves.toBeUndefined();
  });
});

describe("fake cache: failure injection", () => {
  it("fails every method when down, with CACHE_UNAVAILABLE", async () => {
    const cache = createFakeCache({ down: true });

    await expect(cache.getCorpusVersion()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "CACHE_UNAVAILABLE",
    );
    await expect(cache.getRecall(1, key)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "CACHE_UNAVAILABLE",
    );
    await expect(cache.setRecall(1, key, value)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "CACHE_UNAVAILABLE",
    );
    await expect(cache.bumpCorpusVersion()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "CACHE_UNAVAILABLE",
    );
  });

  it("can be brought back up", async () => {
    const cache = createFakeCache({ down: true });
    cache.setDown(false);
    await expect(cache.getCorpusVersion()).resolves.toBeTypeOf("number");
  });

  /* remember must degrade when only the version bump fails: the durable write has
     already landed, so the correct outcome is a stale cache generation, not a
     failed write. */
  it("fails one method in isolation", async () => {
    const cache = createFakeCache();
    cache.setFailure("bumpCorpusVersion", new StrataError("CACHE_UNAVAILABLE", "bump failed"));

    await expect(cache.bumpCorpusVersion()).rejects.toThrow();
    await expect(cache.getCorpusVersion()).resolves.toBe(1);
  });
});
