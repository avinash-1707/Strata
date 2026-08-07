import { describe, expect, it } from "vitest";

import { rankByScore, recallAtK, reciprocalRank, summarize } from "../../eval/metrics.js";

/**
 * Every phase gate from 6 to 11 is a comparison of two numbers this module
 * produces, so a metric that is wrong in the flattering direction does not fail a
 * phase — it approves one. Hence the edge cases, and hence the refusals.
 */

describe("recall@k", () => {
  it("scores a hit inside k and a miss outside it", () => {
    expect(recallAtK(["a", "b", "c"], ["c"], 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["c"], 2)).toBe(0);
  });

  it("is a fraction of the relevant set, not a hit rate", () => {
    // The distinction that matters: a query with two answers, one found. Hit-rate
    // would call this perfect and hide half the failure.
    expect(recallAtK(["a", "x", "y"], ["a", "b"], 3)).toBe(0.5);
  });

  it("ignores position inside k", () => {
    expect(recallAtK(["a", "b"], ["b"], 8)).toBe(1);
    expect(recallAtK(["b", "a"], ["b"], 8)).toBe(1);
  });

  it("does not double-count a duplicated retrieval", () => {
    expect(recallAtK(["a", "a", "a"], ["a", "b"], 8)).toBe(0.5);
  });

  it("refuses a query with no relevant document rather than scoring it", () => {
    expect(() => recallAtK(["a"], [], 8)).toThrow(/cannot be scored/u);
  });

  it("scores an empty retrieval as zero", () => {
    expect(recallAtK([], ["a"], 8)).toBe(0);
  });
});

describe("reciprocal rank", () => {
  it("is 1 for a top hit and 1/n for the nth", () => {
    expect(reciprocalRank(["a", "b", "c"], ["a"], 8)).toBe(1);
    expect(reciprocalRank(["a", "b", "c"], ["c"], 8)).toBeCloseTo(1 / 3);
  });

  it("counts only the first relevant hit", () => {
    expect(reciprocalRank(["x", "a", "b"], ["a", "b"], 8)).toBe(0.5);
  });

  it("is zero when the only hit falls outside k", () => {
    expect(reciprocalRank(["x", "a"], ["a"], 1)).toBe(0);
  });
});

describe("summarize", () => {
  it("averages over queries and names the ones that missed", () => {
    const summary = summarize(
      [
        { queryId: "hit", retrieved: ["a"], relevant: ["a"] },
        { queryId: "miss", retrieved: ["x"], relevant: ["b"] },
      ],
      8,
    );

    expect(summary).toMatchObject({ queries: 2, recall: 0.5, mrr: 0.5 });
    expect(summary.misses).toEqual(["miss"]);
  });

  it("refuses an empty run instead of reporting a perfect one", () => {
    // A run that seeded nothing must not be able to satisfy a phase gate.
    expect(() => summarize([], 8)).toThrow(/no judgements/u);
  });

  /* A partial hit is not a miss: it scored, so listing it under misses would send
     an investigation after the wrong queries. */
  it("does not list a partially-answered query as a miss", () => {
    const summary = summarize([{ queryId: "half", retrieved: ["a"], relevant: ["a", "b"] }], 8);

    expect(summary.recall).toBe(0.5);
    expect(summary.misses).toEqual([]);
  });
});

describe("rankByScore", () => {
  it("orders best first", () => {
    expect(
      rankByScore([
        { id: "low", score: 0.1 },
        { id: "high", score: 0.9 },
      ]),
    ).toEqual(["high", "low"]);
  });

  /* Ties are common — RRF produces them constantly — and an unstable order would
     show up as movement between two eval runs over identical data. */
  it("breaks ties on id so two runs report the same numbers", () => {
    expect(
      rankByScore([
        { id: "b", score: 0.5 },
        { id: "a", score: 0.5 },
      ]),
    ).toEqual(["a", "b"]);
  });
});
