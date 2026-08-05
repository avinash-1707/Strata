import type { Queryable } from "../../db/types.js";
import type { RankedMemory, SearchOptions } from "../types.js";
import type { MemoryRow } from "./memories.js";
import { MEMORY_COLUMNS, toMemoryRecord } from "./memories.js";

/**
 * `websearch_to_tsquery`, not `to_tsquery`: agents pass full sentences with
 * punctuation, and `to_tsquery` raises a syntax error on them (DD-014). The
 * 'english' config is stated explicitly to match the one baked into the
 * generated `summary_tsv` column — a mismatch degrades matching silently.
 */
export async function searchLexical(
  db: Queryable,
  query: string,
  options: SearchOptions,
): Promise<readonly RankedMemory[]> {
  const params: unknown[] = [query];
  let sessionFilter = "";
  if (options.sessionId !== undefined) {
    params.push(options.sessionId);
    sessionFilter = `and session_id = $${String(params.length)}`;
  }
  params.push(options.limit);

  const rows = await db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS}
     from live_memories
     where summary_tsv @@ websearch_to_tsquery('english', $1)
       ${sessionFilter}
     order by ts_rank_cd(summary_tsv, websearch_to_tsquery('english', $1)) desc, id
     limit $${String(params.length)}`,
    params,
  );

  // No similarity: a lexical hit has no cosine, and inventing one would make an
  // absent signal look measured (DD-033).
  return rows.map((row) => ({ memory: toMemoryRecord(row) }));
}
