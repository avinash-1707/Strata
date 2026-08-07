import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db, Row } from "../../src/db/types.js";
import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";
import { createPgStore } from "../../src/store/pg/index.js";
import type { MemoryStore } from "../../src/store/types.js";
import { PG_URL, connectMigrated, truncateMemories } from "../support/integrationDb.js";

/**
 * DD-046, which no fake and no small corpus can express: pgvector's HNSW scan
 * collects `ef_search` candidates by distance and applies the `where` clause
 * *afterwards*, replacing none of what it drops. A session-scoped recall then
 * returns a handful of rows — or none — where hundreds match, with no error.
 *
 * Reproducing it needs three things at once, and all three were established by
 * measuring against this container:
 *
 * 1. **Distinct vectors.** With repeated vectors every candidate ties at the same
 *    distance, the candidate list degenerates, and the scan walks the whole index —
 *    the bug disappears and the suite passes against broken code.
 * 2. **A corpus well past `ef_search`**, whose near neighbours are nearly all out of
 *    scope. 2000 decoys to 50 targets puts roughly two targets in the first 80
 *    candidates, so the filter starves the limit.
 * 3. **A plan that uses the index.** Production gets there by having a real corpus;
 *    at 2050 rows the planner would rather filter and sort, which answers correctly
 *    and proves nothing.
 *
 * Measured on pgvector 0.8.6: without `iterative_scan` this query returns 0 of 8.
 */

/** Enough that the first `ef_search` (80) candidates are almost all out of scope. */
const DECOY_ROWS = 2000;
const TARGET_ROWS = 50;
const LIMIT = 8;

/**
 * Makes `random()` reproducible for the session that seeds. A corpus redrawn every
 * run would make this suite's failures a matter of luck rather than of the code.
 */
const CORPUS_SEED = 0.42;

interface VectorRow extends Row {
  readonly embedding: string;
}

if (PG_URL === undefined) {
  describe.skip("filtered semantic search over a corpus larger than ef_search", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  let db: Db;
  let store: MemoryStore;
  let query: number[];

  beforeAll(async () => {
    await setPlannerPressure("set enable_seqscan = off", "set enable_sort = off");

    // Connects after the settings above: they apply at connection start.
    db = await connectMigrated(url);
    store = createPgStore(db);
    await truncateMemories(db);
    await seed();
    query = await embeddingOf("decoys-1");
  }, 60_000);

  afterAll(async () => {
    await db.close();
    await setPlannerPressure("reset enable_seqscan", "reset enable_sort");
  });

  /**
   * Database-scoped so it reaches the pool the store borrows from — a `set` on one
   * pooled connection would not be there when `searchSemantic` picks another.
   */
  async function setPlannerPressure(...statements: readonly string[]): Promise<void> {
    const admin = await connectMigrated(url);
    try {
      const body = statements
        .map((statement) => `execute format('alter database %I ${statement}', current_database());`)
        .join("\n");
      await admin.query(`do $$ begin\n${body}\nend $$`);
    } finally {
      await admin.close();
    }
  }

  /**
   * One transaction, because `setseed` is session state and the pool would otherwise
   * seed one connection and insert on another. Bulk SQL rather than the store: this
   * suite is about the index, and 2050 rows through the seam would be 4000 round
   * trips. The `where g >= 0` is load-bearing — it correlates the subquery, and
   * without it Postgres evaluates the vector once and reuses it for every row.
   */
  async function seed(): Promise<void> {
    await db.withTransaction(async (tx) => {
      await tx.query("select setseed($1)", [CORPUS_SEED]);
      for (const [sessionId, count] of [
        ["decoys", DECOY_ROWS],
        ["target", TARGET_ROWS],
      ] as const) {
        await tx.query(
          `insert into memories
             (summary, raw_content, content_hash, status, needs_embedding,
              embedding, embedding_model, session_id, tags)
           select 'seeded row', 'seeded row', $1 || '-' || g, 'compressed', false,
                  (select array_agg(random())::vector from generate_series(1, $3) i
                   where g >= 0),
                  'integration-model', $1, '{}'
           from generate_series(1, $2) g`,
          [sessionId, count, EMBEDDING_DIMENSIONS],
        );
      }
    });
  }

  /** The query vector is a decoy's own embedding: nothing is nearer than that. */
  async function embeddingOf(contentHash: string): Promise<number[]> {
    const rows = await db.query<VectorRow>(
      "select embedding::text as embedding from memories where content_hash = $1",
      [contentHash],
    );
    const literal = rows[0]?.embedding;
    if (literal === undefined) {
      throw new Error(`no seeded row for ${contentHash}`);
    }
    return literal.slice(1, -1).split(",").map(Number);
  }

  describe("filtered semantic search over a corpus larger than ef_search (DD-046)", () => {
    it("fills its limit from the scoped session though every near neighbour is out of scope", async () => {
      const hits = await store.searchSemantic(query, { limit: LIMIT, sessionId: "target" });

      expect(hits).toHaveLength(LIMIT);
      expect(hits.every((hit) => hit.memory.sessionId === "target")).toBe(true);
    });

    it("returns every in-scope row when the limit exceeds the session", async () => {
      const hits = await store.searchSemantic(query, {
        limit: TARGET_ROWS + 10,
        sessionId: "target",
      });

      expect(hits).toHaveLength(TARGET_ROWS);
    });

    it("still ranks by distance when nothing is filtered out", async () => {
      const hits = await store.searchSemantic(query, { limit: LIMIT });

      // The decoys really are nearer — which is what makes the cases above a test.
      expect(hits.every((hit) => hit.memory.sessionId === "decoys")).toBe(true);
      const similarities = hits.map((hit) => hit.similarity ?? 0);
      expect([...similarities].sort((a, b) => b - a)).toEqual(similarities);
    });
  });
}
