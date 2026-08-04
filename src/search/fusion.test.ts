import { describe, expect, it } from "vitest";

import { fuseRankings, RRF_K, type RankedList } from "./fusion.js";

const lexical = (ids: readonly string[]): RankedList => ({ name: "lexical", ids });
const semantic = (ids: readonly string[]): RankedList => ({ name: "semantic", ids });

/** Score an id appearing at 1-based `rank` in a single ranker. */
const single = (rank: number, k = RRF_K): number => 1 / (k + rank);

describe("fuseRankings — degenerate inputs", () => {
  it("returns empty for no lists at all", () => {
    expect(fuseRankings([])).toEqual([]);
  });

  it("returns empty when both lists are empty", () => {
    expect(fuseRankings([lexical([]), semantic([])])).toEqual([]);
  });

  it("collapses to semantic order when lexical is empty", () => {
    // The conceptual-query case: no keyword overlap, so only vectors contribute.
    const hits = fuseRankings([lexical([]), semantic(["a", "b", "c"])]);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits.map((h) => h.ranks)).toEqual([
      { semantic: 1 },
      { semantic: 2 },
      { semantic: 3 },
    ]);
  });

  it("collapses to lexical order when semantic is empty", () => {
    // Happens on an empty corpus, on unembedded rows, or after a degraded embed.
    const hits = fuseRankings([lexical(["x", "y"]), semantic([])]);
    expect(hits.map((h) => h.id)).toEqual(["x", "y"]);
  });

  it("handles single-item lists", () => {
    const hits = fuseRankings([lexical(["only"]), semantic([])]);
    expect(hits).toEqual([{ id: "only", score: single(1), ranks: { lexical: 1 } }]);
  });
});

describe("fuseRankings — overlap behavior", () => {
  it("sums contributions for full overlap, rewarding agreement", () => {
    const hits = fuseRankings([lexical(["a", "b"]), semantic(["a", "b"])]);
    expect(hits[0]!.id).toBe("a");
    expect(hits[0]!.score).toBeCloseTo(single(1) * 2, 12);
    expect(hits[0]!.ranks).toEqual({ lexical: 1, semantic: 1 });
  });

  it("ranks an id found by both rankers above one found by only one", () => {
    // "b" is 2nd in both; "a" is 1st in lexical only. Appearing in both lists
    // is the dominant signal in RRF, which is the property we want from hybrid
    // search — and the thing k=60 exaggerates (DD-016).
    const hits = fuseRankings([lexical(["a", "b"]), semantic(["c", "b"])]);
    expect(hits[0]!.id).toBe("b");
    expect(hits[0]!.score).toBeCloseTo(single(2) * 2, 12);
  });

  it("interleaves deterministically with zero overlap", () => {
    const hits = fuseRankings([lexical(["l1", "l2"]), semantic(["s1", "s2"])]);
    // Rank-1 pair ties on score, then on best rank; the id breaks the tie.
    expect(hits.map((h) => h.id)).toEqual(["l1", "s1", "l2", "s2"]);
  });

  it("does not double-count an id repeated within one list", () => {
    // A ranker returning a duplicate must not thereby double its own vote.
    const hits = fuseRankings([lexical(["a", "a", "b"])]);
    expect(hits.find((h) => h.id === "a")!.score).toBeCloseTo(single(1), 12);
    expect(hits.find((h) => h.id === "a")!.ranks).toEqual({ lexical: 1 });
  });

  it("keeps the best rank when an id is duplicated later in a list", () => {
    const hits = fuseRankings([lexical(["a", "b", "a"])]);
    expect(hits.find((h) => h.id === "a")!.ranks).toEqual({ lexical: 1 });
  });
});

describe("fuseRankings — generality and determinism", () => {
  it("fuses more than two rankers", () => {
    const hits = fuseRankings([
      lexical(["a"]),
      semantic(["a"]),
      { name: "tag", ids: ["a"] },
    ]);
    expect(hits[0]!.score).toBeCloseTo(single(1) * 3, 12);
    expect(hits[0]!.ranks).toEqual({ lexical: 1, semantic: 1, tag: 1 });
  });

  it("is order-independent across rankers", () => {
    // Searches run concurrently, so whichever resolves first must not change
    // the outcome.
    const a = fuseRankings([lexical(["x", "y"]), semantic(["y", "z"])]);
    const b = fuseRankings([semantic(["y", "z"]), lexical(["x", "y"])]);
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(a.map((h) => h.score)).toEqual(b.map((h) => h.score));
  });

  it("produces scores in non-increasing order", () => {
    const hits = fuseRankings([
      lexical(["a", "b", "c", "d"]),
      semantic(["d", "c", "e"]),
    ]);
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});

describe("fuseRankings — k", () => {
  it("uses RRF_K by default", () => {
    const [hit] = fuseRankings([lexical(["a"])]);
    expect(hit!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("discriminates more sharply at small k", () => {
    // The DD-016 concern made concrete: at k=60 the gap between rank 1 and
    // rank 2 is tiny; at k=1 it is large. This test exists so tuning k is a
    // measured change rather than a guess.
    const wide = fuseRankings([lexical(["a", "b"])], 60);
    const tight = fuseRankings([lexical(["a", "b"])], 1);
    const ratio = (h: readonly { score: number }[]): number =>
      h[0]!.score / h[1]!.score;
    expect(ratio(tight)).toBeGreaterThan(ratio(wide));
  });

  it("accepts k = 0 without dividing by zero", () => {
    // Guaranteed by 1-based ranks: (0 + 1) is still 1.
    const [hit] = fuseRankings([lexical(["a"])], 0);
    expect(hit!.score).toBe(1);
  });

  it("rejects a negative or non-finite k", () => {
    expect(() => fuseRankings([lexical(["a"])], -1)).toThrow(RangeError);
    expect(() => fuseRankings([lexical(["a"])], Number.NaN)).toThrow(RangeError);
  });
});
