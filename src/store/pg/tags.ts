import type { Queryable } from "../../db/types.js";
import type { MemoryRecord } from "../types.js";
import type { MemoryRow } from "./memories.js";
import { MEMORY_COLUMNS, toMemoryRecord } from "./memories.js";

export async function searchByTag(
  db: Queryable,
  tags: readonly string[],
  match: "any" | "all",
  limit: number,
): Promise<readonly MemoryRecord[]> {
  // `@>` with an empty array matches every row; the tool's input schema is what
  // requires at least one tag, exactly as it does for the fake.
  const operator = match === "all" ? "@>" : "&&";
  const rows = await db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS}
     from live_memories
     where tags ${operator} $1::text[]
     order by created_at desc, id
     limit $2`,
    [[...tags], limit],
  );
  return rows.map(toMemoryRecord);
}
