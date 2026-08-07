/**
 * The arithmetic behind `pnpm eval` (DD-021), kept pure and separate so it can be
 * tested without a database or a model. A miscounted recall figure is the worst
 * possible defect here: every phase gate from 6 to 11 is a comparison of two of
 * these numbers, so a wrong metric does not fail — it approves.
 */

export interface Judgement {
  readonly queryId: string;
  /** Ordered best-first, as the ranker returned it. */
  readonly retrieved: readonly string[];
  readonly relevant: readonly string[];
}

export interface ArmSummary {
  readonly queries: number;
  /** Mean over queries of |relevant ∩ top-k| / |relevant|. */
  readonly recall: number;
  /** Mean reciprocal rank of the first relevant hit; 0 for a query that missed. */
  readonly mrr: number;
  /** Queries that retrieved nothing relevant inside k, in corpus order. */
  readonly misses: readonly string[];
}

/**
 * Fraction of a query's relevant documents that appear in the first `k`.
 *
 * Deliberately *not* "did anything relevant appear": with one relevant document
 * per query the two agree, but the corpus has queries with two, and hit-rate would
 * silently score a ranker that finds one of them as perfect.
 */
export function recallAtK(
  retrieved: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) {
    // A query with no relevant document cannot be scored, and averaging it in as
    // either 0 or 1 would move the number that gates a phase.
    throw new Error("recallAtK: a query with no relevant documents cannot be scored");
  }
  const top = new Set(retrieved.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** 1/rank of the first relevant hit within `k`, or 0 if there is none. */
export function reciprocalRank(
  retrieved: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  const wanted = new Set(relevant);
  const top = retrieved.slice(0, k);
  for (const [index, id] of top.entries()) {
    if (wanted.has(id)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

export function summarize(judgements: readonly Judgement[], k: number): ArmSummary {
  if (judgements.length === 0) {
    // Zero queries averaging to 1.0 would let an empty run satisfy every gate.
    throw new Error("summarize: no judgements to score");
  }

  let recallTotal = 0;
  let rrTotal = 0;
  const misses: string[] = [];

  for (const judgement of judgements) {
    const recall = recallAtK(judgement.retrieved, judgement.relevant, k);
    recallTotal += recall;
    const rr = reciprocalRank(judgement.retrieved, judgement.relevant, k);
    rrTotal += rr;
    if (rr === 0) {
      misses.push(judgement.queryId);
    }
  }

  return {
    queries: judgements.length,
    recall: recallTotal / judgements.length,
    mrr: rrTotal / judgements.length,
    misses,
  };
}

/**
 * Ranked ids from a scored candidate list, best first. Ties break on id so two
 * runs over the same data produce the same report — an unstable order would show
 * up as phantom movement between eval runs.
 */
export function rankByScore(
  scored: readonly { readonly id: string; readonly score: number }[],
): readonly string[] {
  return [...scored]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}
