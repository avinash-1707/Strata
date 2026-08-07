import type { Queryable } from "../../db/types.js";
import type { MemoryRecord } from "../types.js";
import type { MemoryRow } from "./memories.js";
import { MEMORY_COLUMNS, toMemoryRecord } from "./memories.js";

/**
 * Exported so the plan test can `explain` the statement production actually runs.
 * Duplicating the SQL in the test would let the two drift, and the drifting one is
 * the test — it would keep proving the GIN index is used by a query nobody issues.
 *
 * **Internal.** It carries no empty-tags guard: `tags @> '{}'` is true of every row,
 * so anything but `searchByTag` and the plan test calling this reintroduces the
 * matches-everything bug the guard below exists to prevent.
 */
export function tagSearchSql(match: "any" | "all"): string {
  // Both are GIN-supported (DD-018): `&&` is OR over the tags, `@>` is AND.
  const operator = match === "all" ? "@>" : "&&";
  return `select ${MEMORY_COLUMNS}
     from live_memories
     where tags ${operator} $1::text[]
     order by created_at desc, id
     limit $2`;
}

export async function searchByTag(
  db: Queryable,
  tags: readonly string[],
  match: "any" | "all",
  limit: number,
): Promise<readonly MemoryRecord[]> {
  // `@>` with an empty array matches every row. The tool schema already requires
  // one tag, but later phases call the store directly (compaction, DD-012) and
  // will not pass through that schema — so the guard lives at the seam too.
  if (tags.length === 0) {
    return [];
  }
  const rows = await db.query<MemoryRow>(tagSearchSql(match), [[...tags], limit]);
  return rows.map(toMemoryRecord);
}
