/**
 * Reciprocal Rank Fusion:  score(doc) = Σ_r 1 / (k + rank_r(doc))
 *
 * Imports nothing, and must stay that way — this determines retrieval quality,
 * so it has to be testable without a database, cache, or model.
 */

/**
 * 60 comes from the original RRF paper, tuned over TREC runs of ~1000 docs. Over
 * the 20-item lists Strata uses it compresses every contribution into 1/61…1/80,
 * so within-list rank is nearly ignored and "appeared in both lists" becomes the
 * only real signal. DD-016 requires tuning this against the eval harness in
 * Phase 7; until then the value is explicitly unvalidated.
 */
export const RRF_K = 60;

export interface RankedList {
  /** Identifies the ranker in results and logs, e.g. "lexical". */
  readonly name: string;
  readonly ids: readonly string[];
}

export interface FusedHit {
  readonly id: string;
  /** Ordinal only — never threshold on this or show it as a confidence (DD-016). */
  readonly score: number;
  /** 1-based rank per ranker that returned the id; absent rankers are omitted. */
  readonly ranks: Readonly<Record<string, number>>;
}

export function fuseRankings(
  lists: readonly RankedList[],
  k: number = RRF_K,
): FusedHit[] {
  // Negative k would make (k + rank) zero or negative, yielding Infinity or an
  // inverted ranking. Programmer error, not operational — hence a plain
  // RangeError rather than a dependency on the StrataError taxonomy.
  if (!Number.isFinite(k) || k < 0) {
    throw new RangeError(`RRF k must be a finite number >= 0, received ${String(k)}`);
  }

  const ranks = new Map<string, Map<string, number>>();

  for (const list of lists) {
    for (const [index, id] of list.ids.entries()) {
      const rank = index + 1; // 1-based, so (k + rank) >= 1 even at k = 0.

      let perRanker = ranks.get(id);
      if (perRanker === undefined) {
        perRanker = new Map<string, number>();
        ranks.set(id, perRanker);
      }

      // Best rank wins: a ranker repeating an id must not double its own vote.
      const existing = perRanker.get(list.name);
      if (existing === undefined || rank < existing) {
        perRanker.set(list.name, rank);
      }
    }
  }

  const hits: FusedHit[] = [];
  for (const [id, perRanker] of ranks) {
    let score = 0;
    for (const rank of perRanker.values()) {
      score += 1 / (k + rank);
    }
    hits.push({ id, score, ranks: Object.fromEntries(perRanker) });
  }

  return hits.sort(compareHits);
}

/**
 * Ties are common — with zero overlap every same-rank pair ties exactly — so a
 * defined tiebreak is what makes this deterministic and testable. Falling back to
 * input order instead would make results depend on which concurrent search
 * resolved first.
 */
function compareHits(a: FusedHit, b: FusedHit): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const bestA = bestRank(a);
  const bestB = bestRank(b);
  if (bestA !== bestB) {
    return bestA - bestB;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function bestRank(hit: FusedHit): number {
  let best = Number.POSITIVE_INFINITY;
  for (const rank of Object.values(hit.ranks)) {
    if (rank < best) {
      best = rank;
    }
  }
  return best;
}
