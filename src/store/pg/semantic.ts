import type { Db } from "../../db/types.js";
import type { RankedMemory, SearchOptions } from "../types.js";
import type { MemoryRow } from "./memories.js";
import { MEMORY_COLUMNS, toMemoryRecord, vectorLiteral } from "./memories.js";

/**
 * HNSW candidate-list size. 4× the 20-candidate ranker budget, and deliberately
 * not pgvector's default (40) so the no-leak test can tell our setting from the
 * default. Re-examined once the eval harness measures recall on real data
 * (DD-017, DD-021).
 */
const HNSW_EF_SEARCH = 80;

/**
 * Filtered HNSW is post-filtered: the scan collects `ef_search` candidates by
 * distance and *then* drops the ones the `where` clause excludes, replacing none of
 * them. A session-scoped recall over a corpus larger than `ef_search` therefore
 * returns a handful of rows — or zero — where hundreds match, with no error and no
 * warning (DD-046). `relaxed_order` is acceptable because every row carries an
 * explicit `similarity` and fusion re-ranks downstream (DD-016, DD-033).
 *
 * Requires pgvector ≥ 0.8; the compose images are pinned for it.
 */
const HNSW_ITERATIVE_SCAN = "relaxed_order";

/**
 * The ceiling on that iterative scan. Pinned rather than inherited: it is the only
 * thing standing between a highly selective filter and a walk of the whole index,
 * and a default that changed under us would change search latency silently. 20k is
 * far above this deployment's corpus, so at present it never truncates a result —
 * which is the intent. Correctness first at single-user scale (DD-017).
 */
const HNSW_MAX_SCAN_TUPLES = 20_000;

interface SemanticRow extends MemoryRow {
  readonly similarity: number;
}

export async function searchSemantic(
  db: Db,
  vector: readonly number[],
  options: SearchOptions,
): Promise<readonly RankedMemory[]> {
  const params: unknown[] = [vectorLiteral(vector)];
  let sessionFilter = "";
  if (options.sessionId !== undefined) {
    params.push(options.sessionId);
    sessionFilter = `and session_id = $${String(params.length)}`;
  }
  params.push(options.limit);

  // A transaction exists solely to scope the GUC: SET LOCAL, not SET — pg pools
  // connections and a bare SET leaks into whatever query borrows that connection
  // next (DD-017).
  return db.withTransaction(async (tx) => {
    // A GUC cannot be a bind parameter. Every interpolated value is a module
    // constant, never caller input. One statement, not three: this is a foreground
    // read path and each round trip is on the agent's latency.
    await tx.query(
      `set local hnsw.ef_search = ${String(HNSW_EF_SEARCH)};
       set local hnsw.iterative_scan = '${HNSW_ITERATIVE_SCAN}';
       set local hnsw.max_scan_tuples = ${String(HNSW_MAX_SCAN_TUPLES)}`,
    );

    const rows = await tx.query<SemanticRow>(
      // No tiebreak on the order by: HNSW supplies rows in distance order, and a
      // secondary sort key would force a sort node that defeats the index.
      `select ${MEMORY_COLUMNS}, 1 - (embedding <=> $1::vector) as similarity
       from live_memories
       where embedding is not null
         ${sessionFilter}
       order by embedding <=> $1::vector
       limit $${String(params.length)}`,
      params,
    );

    return rows.map((row) => ({ memory: toMemoryRecord(row), similarity: row.similarity }));
  });
}
