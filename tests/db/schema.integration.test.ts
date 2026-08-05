import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db, Row } from "../../src/db/types.js";
import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";
import { createPgStore } from "../../src/store/pg/index.js";
import type { MemoryStore, NewMemory } from "../../src/store/types.js";
import { PG_URL, connectMigrated, truncateMemories } from "../support/integrationDb.js";

function vector(width: number): number[] {
  return Array.from({ length: width }, (_unused, index) => Math.sin(index));
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    summary: "a schema-suite row",
    rawContent: "a schema-suite row",
    contentHash: `hash-${Math.random().toString(36).slice(2)}`,
    tags: [],
    sessionId: null,
    ...overrides,
  };
}

interface PlanRow extends Row {
  readonly "QUERY PLAN": string;
}

if (PG_URL === undefined) {
  describe.skip("schema behavior against real Postgres", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  let db: Db;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await connectMigrated(url);
    store = createPgStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateMemories(db);
  });

  /**
   * The plan for `sql`, with seqscan *and* sort priced out so index usability is
   * what shows. Both matter: on a near-empty table the planner will happily take
   * any index scan plus a free Sort node, which would "pass" without ever proving
   * the view lets the ordering index supply the order.
   */
  async function plan(sql: string, params?: readonly unknown[]): Promise<string> {
    return db.withTransaction(async (tx) => {
      await tx.query("set local enable_seqscan = off");
      await tx.query("set local enable_sort = off");
      const rows = await tx.query<PlanRow>(`explain ${sql}`, params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  }

  describe("vector width (DD-017)", () => {
    it(`rejects a ${String(EMBEDDING_DIMENSIONS - 1)}-dimension vector and accepts ${String(EMBEDDING_DIMENSIONS)}`, async () => {
      const inserted = await store.insertRaw(newMemory());

      await expect(
        store.applyEnhancement(inserted.id, {
          summary: "wrong width",
          tags: [],
          embedding: vector(EMBEDDING_DIMENSIONS - 1),
          embeddingModel: "test-model",
        }),
      ).rejects.toMatchObject({ code: "DB_QUERY_FAILED" });

      await expect(
        store.applyEnhancement(inserted.id, {
          summary: "right width",
          tags: [],
          embedding: vector(EMBEDDING_DIMENSIONS),
          embeddingModel: "test-model",
        }),
      ).resolves.toMatchObject({ needsEmbedding: false });
    });
  });

  describe("summary_tsv (DD-004)", () => {
    it("populates without ever being written to", async () => {
      const row = await store.insertRaw(newMemory({ summary: "postgres pooling notes" }));

      const tsv = await db.query<{ tsv: string }>(
        "select summary_tsv::text as tsv from memories where id = $1",
        [row.id],
      );
      expect(tsv[0]?.tsv).toContain("postgr");
    });

    it("covers raw_content terms the summary does not carry", async () => {
      const row = await store.insertRaw(
        newMemory({
          summary: "a short placeholder",
          rawContent: "the original text mentions zanzibar exactly once",
        }),
      );

      const hits = await store.searchLexical("zanzibar", { limit: 8 });
      expect(hits.map((hit) => hit.memory.id)).toContain(row.id);
    });
  });

  describe("indexes (DD-013, DD-017)", () => {
    it("created every index migration 001 owes, on a table that was empty", async () => {
      const rows = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where tablename = $1",
        ["memories"],
      );
      const names = rows.map((row) => row.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          "memories_embedding_idx",
          "memories_tsv_idx",
          "memories_tags_idx",
          "memories_session_idx",
          "memories_hash_idx",
          "memories_live_idx",
          "memories_backlog_idx",
          "memories_hash_live_idx",
        ]),
      );
    });
  });

  describe("the live_memories view does not defeat the indexes (invariant 11)", () => {
    it("recency reads through the view use memories_live_idx", async () => {
      const text = await plan("select id from live_memories order by created_at desc limit 5");
      expect(text).toContain("memories_live_idx");
    });

    it("nearest-neighbour reads through the view use the HNSW index", async () => {
      const text = await plan(
        `select id from live_memories
         where embedding is not null
         order by embedding <=> $1::vector
         limit 8`,
        [`[${vector(EMBEDDING_DIMENSIONS).join(",")}]`],
      );
      expect(text).toContain("memories_embedding_idx");
    });

    it("hash lookups through the view use an index on content_hash", async () => {
      const text = await plan("select id from live_memories where content_hash = 'x'");
      expect(text).toMatch(/memories_hash(_live)?_idx/);
    });
  });

  describe("hnsw.ef_search scoping (DD-017)", () => {
    it("a bare SET does leak across a pooled connection — the hazard is real", async () => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        await pool.query("set hnsw.ef_search = 397");
        // Same pool, next borrow: with max 1 this is provably the same connection.
        const after = await pool.query<{ value: string }>(
          "select current_setting('hnsw.ef_search') as value",
        );
        expect(after.rows[0]?.value).toBe("397");
      } finally {
        await pool.end();
      }
    });

    it("searchSemantic leaves the borrowed connection at its default", async () => {
      // Touching a vector loads the extension in-session, which is what defines
      // the GUC for current_setting on this connection.
      await db.query(`select '[${vector(EMBEDDING_DIMENSIONS).join(",")}]'::vector as warm`);
      // Captured, not hardcoded: the assertion must not depend on pgvector's 40.
      const baseline = await db.query<{ value: string }>(
        "select current_setting('hnsw.ef_search') as value",
      );
      const before = baseline[0]?.value;
      expect(before).toBeDefined();

      await store.searchSemantic(vector(EMBEDDING_DIMENSIONS), { limit: 8 });

      const after = await db.query<{ value: string }>(
        "select current_setting('hnsw.ef_search') as value",
      );
      // The store sets 80 inside its transaction; seeing the pre-call value here is
      // exactly the no-leak guarantee.
      expect(after[0]?.value).toBe(before);
      expect(after[0]?.value).not.toBe("80");
    });
  });
}
