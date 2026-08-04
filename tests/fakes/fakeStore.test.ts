import { describe, expect, it } from "vitest";

import { isStrataError, StrataError } from "../../src/errors.js";
import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";
import { createFakeStore } from "./fakeStore.js";

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => Math.sin(seed + i));
}

const LIMIT = 10;

describe("fake store: live-row filtering (DD-012)", () => {
  it("hides soft-deleted rows from every read", async () => {
    const store = createFakeStore({
      rows: [
        { id: "a", summary: "postgres connection pooling", tags: ["db"] },
        { id: "b", summary: "postgres vacuum settings", tags: ["db"], deletedAt: new Date() },
      ],
    });

    const lexical = await store.searchLexical("postgres", { limit: LIMIT });
    const byTag = await store.searchByTag(["db"], "any", LIMIT);
    const byHash = await store.findLiveByContentHash("hash-b");

    expect(lexical.map((hit) => hit.memory.id)).toEqual(["a"]);
    expect(byTag.map((row) => row.id)).toEqual(["a"]);
    expect(byHash).toBeUndefined();
  });

  it("hides superseded rows from every read", async () => {
    const store = createFakeStore({
      rows: [
        { id: "merged", summary: "postgres notes", tags: ["db"], compactionDepth: 1 },
        { id: "input", summary: "postgres notes", tags: ["db"], supersededBy: "merged" },
      ],
    });

    const lexical = await store.searchLexical("postgres", { limit: LIMIT });
    expect(lexical.map((hit) => hit.memory.id)).toEqual(["merged"]);
  });

  it("keeps a soft-deleted row present in storage, since forget is not a purge", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "x" }] });
    await store.softDelete("a");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("fake store: writes", () => {
  it("inserts at status raw and needing an embedding (DD-005 stage 1)", async () => {
    const store = createFakeStore();
    const row = await store.insertRaw({
      summary: "truncated placeholder",
      rawContent: "the full original content",
      contentHash: "h1",
      tags: ["a"],
      sessionId: null,
    });

    expect(row).toMatchObject({
      status: "raw",
      needsEmbedding: true,
      embeddingModel: null,
      summary: "truncated placeholder",
    });
  });

  it("is idempotent on an exact duplicate hash (DD-020)", async () => {
    const store = createFakeStore();
    const input = {
      summary: "s",
      rawContent: "c",
      contentHash: "same",
      tags: [],
      sessionId: null,
    };
    const first = await store.insertRaw(input);
    const second = await store.insertRaw(input);

    expect(second.id).toBe(first.id);
    expect(store.rows).toHaveLength(1);
  });

  it("re-inserts when the previous row with that hash was forgotten", async () => {
    const store = createFakeStore();
    const input = { summary: "s", rawContent: "c", contentHash: "h", tags: [], sessionId: null };
    const first = await store.insertRaw(input);
    await store.softDelete(first.id);
    const second = await store.insertRaw(input);

    expect(second.id).not.toBe(first.id);
  });

  it("promotes to compressed when an enhancement carries an embedding", async () => {
    const store = createFakeStore();
    const row = await store.insertRaw({
      summary: "raw",
      rawContent: "raw",
      contentHash: "h",
      tags: ["caller"],
      sessionId: null,
    });

    const updated = await store.applyEnhancement(row.id, {
      summary: "compressed",
      tags: ["caller", "model"],
      embedding: vector(1),
      embeddingModel: "nomic-embed-text",
    });

    expect(updated).toMatchObject({
      summary: "compressed",
      status: "compressed",
      needsEmbedding: false,
      embeddingModel: "nomic-embed-text",
      tags: ["caller", "model"],
    });
  });

  /* DD-005: compression can succeed while embedding fails. The row must stop being
     "raw" without pretending it is searchable semantically. */
  it("leaves needsEmbedding true when the enhancement has no vector", async () => {
    const store = createFakeStore();
    const row = await store.insertRaw({
      summary: "raw",
      rawContent: "raw",
      contentHash: "h",
      tags: [],
      sessionId: null,
    });

    const updated = await store.applyEnhancement(row.id, {
      summary: "compressed",
      tags: [],
      embedding: null,
      embeddingModel: null,
    });

    expect(updated).toMatchObject({ status: "compressed", needsEmbedding: true });
    const semantic = await store.searchSemantic(vector(1), { limit: LIMIT });
    expect(semantic).toEqual([]);
  });

  it("returns undefined when a forget lands before the enhancement", async () => {
    const store = createFakeStore();
    const row = await store.insertRaw({
      summary: "raw",
      rawContent: "raw",
      contentHash: "h",
      tags: [],
      sessionId: null,
    });
    await store.softDelete(row.id);

    await expect(
      store.applyEnhancement(row.id, {
        summary: "compressed",
        tags: [],
        embedding: vector(1),
        embeddingModel: "m",
      }),
    ).resolves.toBeUndefined();
  });

  it("restores a forgotten row, making it visible to every read again (DD-039)", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "redis notes", tags: ["db"] }] });

    await store.softDelete("a");
    await expect(store.searchLexical("redis", { limit: LIMIT })).resolves.toEqual([]);

    await expect(store.restore("a")).resolves.toBe(true);
    const hits = await store.searchLexical("redis", { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["a"]);
    expect(store.rows[0]?.deletedAt).toBeNull();
  });

  it("reports false for a row that was never deleted — nothing to undo", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "x" }] });
    await expect(store.restore("a")).resolves.toBe(false);
  });

  it("reports false for an unknown id", async () => {
    const store = createFakeStore();
    await expect(store.restore("ghost")).resolves.toBe(false);
  });

  /* Resurrecting a compaction input would duplicate content its merged replacement
     already covers, so restore is scoped to forget, not to supersession (DD-012). */
  it("refuses to restore a superseded row", async () => {
    const store = createFakeStore({
      rows: [
        { id: "merged", summary: "postgres notes" },
        {
          id: "input",
          summary: "postgres notes",
          supersededBy: "merged",
          deletedAt: new Date(),
        },
      ],
    });

    await expect(store.restore("input")).resolves.toBe(false);
    const hits = await store.searchLexical("postgres", { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["merged"]);
  });

  it("is idempotent — restoring twice is not an error", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "x" }] });
    await store.softDelete("a");
    await expect(store.restore("a")).resolves.toBe(true);
    await expect(store.restore("a")).resolves.toBe(false);
  });

  it("reports whether a soft delete matched a live row", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "x" }] });
    await expect(store.softDelete("a")).resolves.toBe(true);
    await expect(store.softDelete("a")).resolves.toBe(false);
    await expect(store.softDelete("nope")).resolves.toBe(false);
  });
});

describe("fake store: lexical search", () => {
  // Rank is array position, not a field — fusion derives it from the index.
  it("orders by number of matching terms, best first", async () => {
    const store = createFakeStore({
      rows: [
        { id: "both", summary: "redis cache invalidation" },
        { id: "one", summary: "redis persistence" },
      ],
    });

    const hits = await store.searchLexical("redis cache", { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["both", "one"]);
  });

  it("returns no similarity, because a lexical hit has no cosine (DD-033)", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "redis" }] });
    const hits = await store.searchLexical("redis", { limit: LIMIT });
    expect(hits[0]).not.toHaveProperty("similarity");
  });

  it("matches an empty query to nothing, as an empty tsquery would", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "anything" }] });
    await expect(store.searchLexical("   ", { limit: LIMIT })).resolves.toEqual([]);
  });

  it("honors the limit", async () => {
    const store = createFakeStore({
      rows: [
        { id: "a", summary: "redis one" },
        { id: "b", summary: "redis two" },
        { id: "c", summary: "redis three" },
      ],
    });
    await expect(store.searchLexical("redis", { limit: 2 })).resolves.toHaveLength(2);
  });

  it("searches raw content as well as summary (DD-004)", async () => {
    const store = createFakeStore({
      rows: [{ id: "a", summary: "short", rawContent: "a mention of pgbouncer in the original" }],
    });
    const hits = await store.searchLexical("pgbouncer", { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["a"]);
  });

  it("filters by session when asked (DD-018)", async () => {
    const store = createFakeStore({
      rows: [
        { id: "mine", summary: "redis notes", sessionId: "s1" },
        { id: "theirs", summary: "redis notes", sessionId: "s2" },
        { id: "global", summary: "redis notes", sessionId: null },
      ],
    });

    const hits = await store.searchLexical("redis", { limit: LIMIT, sessionId: "s1" });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["mine"]);
  });
});

describe("fake store: ranking overrides, for tests about fusion rather than matching", () => {
  const rows = [
    { id: "a", summary: "redis", embedding: vector(1) },
    { id: "b", summary: "redis", embedding: vector(2) },
    { id: "c", summary: "redis", embedding: vector(3) },
  ];

  it("imposes the given order on lexical results", async () => {
    const store = createFakeStore({ rows, lexicalRanking: ["c", "a"] });
    const hits = await store.searchLexical("redis", { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["c", "a"]);
  });

  it("imposes the given order on semantic results, keeping similarity descending", async () => {
    const store = createFakeStore({ rows, semanticRanking: ["b", "c"] });
    const hits = await store.searchSemantic(vector(1), { limit: LIMIT });

    expect(hits.map((hit) => hit.memory.id)).toEqual(["b", "c"]);
    expect(hits[0]?.similarity).toBeGreaterThan(hits[1]?.similarity ?? 1);
  });

  it("still honors the limit", async () => {
    const store = createFakeStore({ rows, lexicalRanking: ["c", "b", "a"] });
    await expect(store.searchLexical("redis", { limit: 2 })).resolves.toHaveLength(2);
  });

  /* A silent drop here would leave a fusion test fusing empty lists and passing. */
  it("throws when the override names a row the query does not match", async () => {
    const store = createFakeStore({ rows, lexicalRanking: ["a", "ghost"] });
    await expect(store.searchLexical("redis", { limit: LIMIT })).rejects.toThrow(/ghost/);
  });

  it("throws when the override names a forgotten row", async () => {
    const store = createFakeStore({ rows, lexicalRanking: ["a", "b"] });
    await store.softDelete("b");
    await expect(store.searchLexical("redis", { limit: LIMIT })).rejects.toThrow(/\bb\b/);
  });
});

describe("fake store: setDown covers the Postgres-down row of the failure table", () => {
  it("fails every method with DB_QUERY_FAILED", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "redis" }], down: true });
    const isDbFailure = (error: unknown): boolean =>
      isStrataError(error) && error.code === "DB_QUERY_FAILED";

    await expect(store.findLiveByContentHash("h")).rejects.toSatisfy(isDbFailure);
    await expect(
      store.insertRaw({ summary: "s", rawContent: "c", contentHash: "h", tags: [], sessionId: null }),
    ).rejects.toSatisfy(isDbFailure);
    await expect(store.searchLexical("redis", { limit: LIMIT })).rejects.toSatisfy(isDbFailure);
    await expect(store.searchSemantic(vector(1), { limit: LIMIT })).rejects.toSatisfy(isDbFailure);
    await expect(store.searchByTag(["x"], "any", LIMIT)).rejects.toSatisfy(isDbFailure);
    await expect(store.touchUsage(["a"])).rejects.toSatisfy(isDbFailure);
    await expect(store.softDelete("a")).rejects.toSatisfy(isDbFailure);
    await expect(store.findEnhancementBacklog(LIMIT)).rejects.toSatisfy(isDbFailure);
    await expect(store.restore("a")).rejects.toSatisfy(isDbFailure);
    await expect(
      store.applyEnhancement("a", { summary: "s", tags: [], embedding: null, embeddingModel: null }),
    ).rejects.toSatisfy(isDbFailure);
  });

  it("can be brought back up", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "redis" }], down: true });
    store.setDown(false);
    await expect(store.searchByTag(["x"], "any", LIMIT)).resolves.toEqual([]);
  });
});

describe("fake store: semantic search", () => {
  it("ignores rows with no embedding", async () => {
    const store = createFakeStore({
      rows: [
        { id: "embedded", summary: "a", embedding: vector(1) },
        { id: "not", summary: "a" },
      ],
    });

    const hits = await store.searchSemantic(vector(1), { limit: LIMIT });
    expect(hits.map((hit) => hit.memory.id)).toEqual(["embedded"]);
  });

  it("carries a similarity, unlike the lexical ranker", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "a", embedding: vector(1) }] });
    const hits = await store.searchSemantic(vector(1), { limit: LIMIT });
    expect(hits[0]?.similarity).toBeTypeOf("number");
  });

  it("orders nearer vectors first", async () => {
    const store = createFakeStore({
      rows: [
        { id: "near", summary: "n", embedding: vector(1) },
        { id: "far", summary: "f", embedding: vector(900) },
      ],
    });

    const hits = await store.searchSemantic(vector(1), { limit: LIMIT });
    expect(hits[0]?.memory.id).toBe("near");
  });
});

describe("fake store: tag search", () => {
  const rows = [
    { id: "a", summary: "a", tags: ["db", "postgres"] },
    { id: "b", summary: "b", tags: ["db"] },
    { id: "c", summary: "c", tags: ["redis"] },
  ];

  it("defaults to OR semantics", async () => {
    const store = createFakeStore({ rows });
    const found = await store.searchByTag(["postgres", "redis"], "any", LIMIT);
    expect(found.map((row) => row.id).sort()).toEqual(["a", "c"]);
  });

  it("requires every tag under match:all", async () => {
    const store = createFakeStore({ rows });
    const found = await store.searchByTag(["db", "postgres"], "all", LIMIT);
    expect(found.map((row) => row.id)).toEqual(["a"]);
  });

  it("returns an empty list rather than erroring on no match", async () => {
    const store = createFakeStore({ rows });
    await expect(store.searchByTag(["nothing"], "any", LIMIT)).resolves.toEqual([]);
  });

  it("returns newest first", async () => {
    const store = createFakeStore({ rows });
    const found = await store.searchByTag(["db"], "any", LIMIT);
    expect(found.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

describe("fake store: usage tracking (DD-011)", () => {
  it("records touched ids and increments recall_count", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "a" }] });
    await store.touchUsage(["a", "a"]);

    expect(store.touched).toEqual(["a", "a"]);
    expect(store.rows[0]).toMatchObject({ recallCount: 2 });
    expect(store.rows[0]?.lastRecalledAt).toBeInstanceOf(Date);
  });

  it("ignores an unknown id without throwing", async () => {
    const store = createFakeStore();
    await expect(store.touchUsage(["ghost"])).resolves.toBeUndefined();
    expect(store.touched).toEqual(["ghost"]);
  });
});

describe("fake store: backlog (DD-005 stage 3)", () => {
  it("claims rows that are raw or awaiting an embedding, and nothing else", async () => {
    const store = createFakeStore({
      rows: [
        { id: "raw", summary: "r", status: "raw", needsEmbedding: true },
        { id: "unembedded", summary: "u", status: "compressed", needsEmbedding: true },
        { id: "done", summary: "d", status: "compressed", needsEmbedding: false },
        { id: "gone", summary: "g", status: "raw", needsEmbedding: true, deletedAt: new Date() },
      ],
    });

    const claimed = await store.findEnhancementBacklog(LIMIT);
    expect(claimed.map((row) => row.id)).toEqual(["raw", "unembedded"]);
  });
});

describe("fake store: failure injection", () => {
  it("makes one method fail while the others keep working", async () => {
    const store = createFakeStore({ rows: [{ id: "a", summary: "redis" }] });
    store.setFailure("searchLexical", new StrataError("DB_QUERY_FAILED", "boom"));

    await expect(store.searchLexical("redis", { limit: LIMIT })).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
    await expect(store.searchByTag([], "any", LIMIT)).resolves.toEqual([]);
  });

  it("clears an injected failure", async () => {
    const store = createFakeStore();
    store.setFailure("touchUsage", new StrataError("DB_QUERY_FAILED", "boom"));
    await expect(store.touchUsage(["a"])).rejects.toThrow();
    store.setFailure("touchUsage", undefined);
    await expect(store.touchUsage(["a"])).resolves.toBeUndefined();
  });

  it("records the methods called, in order", async () => {
    const store = createFakeStore();
    await store.searchByTag([], "any", LIMIT);
    await store.touchUsage([]);
    expect(store.calls).toEqual(["searchByTag", "touchUsage"]);
  });
});

describe("fake store: blocking, for concurrency assertions without timing", () => {
  it("lets both searches enter before either resolves", async () => {
    const store = createFakeStore({
      rows: [{ id: "a", summary: "redis", embedding: vector(1) }],
    });
    const releaseLexical = store.block("searchLexical");
    const releaseSemantic = store.block("searchSemantic");

    const both = Promise.all([
      store.searchLexical("redis", { limit: LIMIT }),
      store.searchSemantic(vector(1), { limit: LIMIT }),
    ]);

    // Both must have been *entered* — proving the calls were issued concurrently
    // rather than one awaited before the other was started.
    await Promise.resolve();
    expect(store.calls).toEqual(["searchLexical", "searchSemantic"]);

    releaseLexical();
    releaseSemantic();
    const [lexical, semantic] = await both;
    expect(lexical).toHaveLength(1);
    expect(semantic).toHaveLength(1);
  });
});
