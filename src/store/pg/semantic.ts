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
    // A GUC cannot be a bind parameter. The interpolated value is a module
    // constant, never caller input.
    await tx.query(`set local hnsw.ef_search = ${String(HNSW_EF_SEARCH)}`);

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
