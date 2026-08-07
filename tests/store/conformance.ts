import { beforeEach, describe, expect, it } from "vitest";

import { MAX_ENHANCEMENT_ATTEMPTS } from "../../src/config/budgets.js";
import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";
import type {
  EnhancementRetryPolicy,
  MemoryRecord,
  MemoryStore,
  NewMemory,
} from "../../src/store/types.js";

/**
 * The `MemoryStore` contract, as a suite any implementation must pass (DD-032 item
 * 10). Phase 4 points this at real Postgres; if the two disagree, this is where it
 * surfaces rather than in a tool test that passes against the fake and fails in
 * production.
 *
 * Two rules keep it honest:
 *
 * 1. **Only the seam.** Rows are created through `insertRaw` and mutated through
 *    `applyEnhancement` / `softDelete`, never through a fake's `seed`. A helper the
 *    Postgres store does not have is a helper this suite cannot use.
 * 2. **Contract, not ranking.** `ts_rank_cd` and HNSW recall legitimately differ from
 *    the fake's substring counting, so nothing here asserts an ordering that ranking
 *    quality could change. Membership, live-filtering and bookkeeping are the
 *    contract; relevance is measured by the eval harness (DD-021).
 */
export interface StoreHarness {
  readonly store: MemoryStore;
}

const LIMIT = 20;

/**
 * Backoff disabled, so cases about *which* rows the backlog holds are not also
 * asserting how long it waits. The wait itself gets its own case below (DD-045).
 */
const NO_BACKOFF: EnhancementRetryPolicy = {
  maxAttempts: MAX_ENHANCEMENT_ATTEMPTS,
  retryBaseMs: 0,
};

/** pgvector rejects a width mismatch outright, so every vector here must be exact. */
function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
    Math.sin(seed + index),
  );
}

/**
 * Separates two inserts in time. `created_at` has millisecond resolution, and
 * neither this contract nor `order by created_at desc` defines a tiebreak — so
 * asserting a recency order over two rows written in the same millisecond would be
 * asserting an implementation's incidental sort stability.
 */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    summary: "Postgres connection pool exhaustion caused job timeouts",
    rawContent: "Postgres connection pool exhaustion caused job timeouts",
    contentHash: `hash-${Math.random().toString(36).slice(2)}`,
    tags: [],
    sessionId: null,
    ...overrides,
  };
}

export function describeMemoryStore(
  label: string,
  createHarness: () => Promise<StoreHarness>,
): void {
  describe(`${label}: MemoryStore conformance`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      ({ store } = await createHarness());
    });

    /** Compresses a row the way DD-005 stage 2 does, so reads have something to find. */
    async function compressed(
      overrides: Partial<NewMemory> = {},
      embedding: readonly number[] | null = vector(1),
    ): Promise<MemoryRecord> {
      const inserted = await store.insertRaw(newMemory(overrides));
      const updated = await store.applyEnhancement(inserted.id, {
        summary: overrides.summary ?? newMemory().summary,
        tags: overrides.tags ?? [],
        embedding,
        embeddingModel: embedding === null ? null : "conformance-model",
      });
      expect(updated).toBeDefined();
      return updated!;
    }

    describe("insertRaw", () => {
      it("lands durably at status raw, awaiting an embedding", async () => {
        const row = await store.insertRaw(newMemory({ tags: ["postgres"], sessionId: "conv-1" }));

        expect(row.status).toBe("raw");
        expect(row.needsEmbedding).toBe(true);
        expect(row.embeddingModel).toBeNull();
        expect(row.tags).toEqual(["postgres"]);
        expect(row.sessionId).toBe("conv-1");
        expect(row.deletedAt).toBeNull();
        expect(row.supersededBy).toBeNull();
        expect(row.createdAt).toBeInstanceOf(Date);
      });

      it("starts every row with no usage and no attempts", async () => {
        const row = await store.insertRaw(newMemory());

        expect(row.recallCount).toBe(0);
        expect(row.lastRecalledAt).toBeNull();
        expect(row.enhancementAttempts).toBe(0);
        expect(row.lastAttemptAt).toBeNull();
        expect(row.compactionDepth).toBe(0);
      });

      it("gives distinct content distinct ids", async () => {
        const first = await store.insertRaw(newMemory({ contentHash: "one" }));
        const second = await store.insertRaw(newMemory({ contentHash: "two" }));

        expect(second.id).not.toBe(first.id);
      });
    });

    describe("findLiveByContentHash (DD-020)", () => {
      it("finds a live row by its hash", async () => {
        const row = await store.insertRaw(newMemory({ contentHash: "abc" }));

        await expect(store.findLiveByContentHash("abc")).resolves.toMatchObject({ id: row.id });
      });

      it("returns undefined for a hash nothing carries", async () => {
        await expect(store.findLiveByContentHash("nothing")).resolves.toBeUndefined();
      });

      /* The unique index behind this is partial, so forgotten content can be stored
         again — which is only meaningful if the lookup stops finding it. */
      it("stops finding a row once it is soft-deleted", async () => {
        const row = await store.insertRaw(newMemory({ contentHash: "abc" }));
        await store.softDelete(row.id);

        await expect(store.findLiveByContentHash("abc")).resolves.toBeUndefined();
      });
    });

    describe("applyEnhancement (DD-005 stage 2)", () => {
      it("replaces the summary and tags, and marks the row compressed", async () => {
        const inserted = await store.insertRaw(newMemory({ tags: ["caller"] }));

        const updated = await store.applyEnhancement(inserted.id, {
          summary: "compressed form",
          tags: ["caller", "model"],
          embedding: vector(2),
          embeddingModel: "conformance-model",
        });

        expect(updated).toMatchObject({
          summary: "compressed form",
          status: "compressed",
          needsEmbedding: false,
          embeddingModel: "conformance-model",
        });
        expect(updated?.tags).toEqual(["caller", "model"]);
      });

      /* Compression can succeed while embedding fails, and the row must stay in the
         backlog for the embedding alone. */
      it("keeps needs_embedding when no vector was produced", async () => {
        const inserted = await store.insertRaw(newMemory());

        const updated = await store.applyEnhancement(inserted.id, {
          summary: "compressed form",
          tags: [],
          embedding: null,
          embeddingModel: null,
        });

        expect(updated).toMatchObject({ status: "compressed", needsEmbedding: true });
      });

      it("resolves undefined when a forget landed first", async () => {
        const inserted = await store.insertRaw(newMemory());
        await store.softDelete(inserted.id);

        await expect(
          store.applyEnhancement(inserted.id, {
            summary: "compressed form",
            tags: [],
            embedding: vector(3),
            embeddingModel: "conformance-model",
          }),
        ).resolves.toBeUndefined();
      });

      it("resolves undefined for an id nothing carries", async () => {
        await expect(
          store.applyEnhancement("00000000-0000-4000-8000-000000000999", {
            summary: "x",
            tags: [],
            embedding: null,
            embeddingModel: null,
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe("searchLexical (DD-014)", () => {
      it("finds a row by a distinctive word in its summary", async () => {
        const row = await compressed({ summary: "pgvector was chosen for the vector store" });

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });

        expect(hits.map((hit) => hit.memory.id)).toContain(row.id);
      });

      /* DD-033: a lexical hit has no cosine, and inventing one would make an absent
         signal look measured. */
      it("never attaches a similarity", async () => {
        await compressed({ summary: "pgvector was chosen" });

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });

        expect(hits.every((hit) => hit.similarity === undefined)).toBe(true);
      });

      it("excludes a soft-deleted row (DD-012)", async () => {
        const row = await compressed({ summary: "pgvector was chosen" });
        await store.softDelete(row.id);

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });

        expect(hits.map((hit) => hit.memory.id)).not.toContain(row.id);
      });

      it("honors the limit", async () => {
        await compressed({ summary: "pgvector one", contentHash: "one" });
        await compressed({ summary: "pgvector two", contentHash: "two" });

        const hits = await store.searchLexical("pgvector", { limit: 1 });

        expect(hits).toHaveLength(1);
      });

      it("scopes to a session when asked (DD-018)", async () => {
        const mine = await compressed({ summary: "pgvector mine", contentHash: "a", sessionId: "conv-1" });
        await compressed({ summary: "pgvector theirs", contentHash: "b", sessionId: "conv-2" });

        const hits = await store.searchLexical("pgvector", { limit: LIMIT, sessionId: "conv-1" });

        expect(hits.map((hit) => hit.memory.id)).toEqual([mine.id]);
      });

      it("returns nothing rather than everything for a query with no terms", async () => {
        await compressed({ summary: "pgvector was chosen" });

        await expect(store.searchLexical("   ", { limit: LIMIT })).resolves.toEqual([]);
      });
    });

    describe("searchSemantic (DD-017)", () => {
      it("finds an embedded row and reports its similarity", async () => {
        const row = await compressed({}, vector(1));

        const hits = await store.searchSemantic(vector(1), { limit: LIMIT });

        const hit = hits.find((candidate) => candidate.memory.id === row.id);
        expect(hit).toBeDefined();
        expect(typeof hit?.similarity).toBe("number");
      });

      it("cannot see a row that has no embedding", async () => {
        const row = await compressed({}, null);

        const hits = await store.searchSemantic(vector(1), { limit: LIMIT });

        expect(hits.map((hit) => hit.memory.id)).not.toContain(row.id);
      });

      it("excludes a soft-deleted row (DD-012)", async () => {
        const row = await compressed({}, vector(1));
        await store.softDelete(row.id);

        const hits = await store.searchSemantic(vector(1), { limit: LIMIT });

        expect(hits.map((hit) => hit.memory.id)).not.toContain(row.id);
      });

      it("honors the limit", async () => {
        await compressed({ contentHash: "one" }, vector(1));
        await compressed({ contentHash: "two" }, vector(2));

        await expect(store.searchSemantic(vector(1), { limit: 1 })).resolves.toHaveLength(1);
      });

      it("scopes to a session when asked", async () => {
        const mine = await compressed({ contentHash: "a", sessionId: "conv-1" }, vector(1));
        await compressed({ contentHash: "b", sessionId: "conv-2" }, vector(2));

        const hits = await store.searchSemantic(vector(1), { limit: LIMIT, sessionId: "conv-1" });

        expect(hits.map((hit) => hit.memory.id)).toEqual([mine.id]);
      });
    });

    describe("searchByTag", () => {
      it("matches any of the given tags", async () => {
        const a = await compressed({ contentHash: "a", tags: ["postgres"] });
        const b = await compressed({ contentHash: "b", tags: ["redis"] });

        const rows = await store.searchByTag(["postgres", "redis"], "any", LIMIT);

        expect(rows.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
      });

      it("requires all of the given tags under all", async () => {
        const both = await compressed({ contentHash: "a", tags: ["postgres", "vectors"] });
        await compressed({ contentHash: "b", tags: ["postgres"] });

        const rows = await store.searchByTag(["postgres", "vectors"], "all", LIMIT);

        expect(rows.map((row) => row.id)).toEqual([both.id]);
      });

      it("returns newest first", async () => {
        const first = await compressed({ contentHash: "a", tags: ["t"] });
        await tick();
        const second = await compressed({ contentHash: "b", tags: ["t"] });

        const rows = await store.searchByTag(["t"], "any", LIMIT);

        expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
      });

      it("honors the limit", async () => {
        await compressed({ contentHash: "a", tags: ["t"] });
        await compressed({ contentHash: "b", tags: ["t"] });

        await expect(store.searchByTag(["t"], "any", 1)).resolves.toHaveLength(1);
      });

      it("excludes a soft-deleted row (DD-012)", async () => {
        const row = await compressed({ tags: ["t"] });
        await store.softDelete(row.id);

        await expect(store.searchByTag(["t"], "any", LIMIT)).resolves.toEqual([]);
      });

      it("returns an empty array when no row carries the tag", async () => {
        await expect(store.searchByTag(["absent"], "any", LIMIT)).resolves.toEqual([]);
      });

      /* `tags @> '{}'` matches every row in Postgres. Later phases call the store
         without the tool schema in front, so the guard must live at the seam. */
      it("returns nothing for an empty tag list", async () => {
        await compressed({ tags: ["t"] });

        await expect(store.searchByTag([], "all", LIMIT)).resolves.toEqual([]);
        await expect(store.searchByTag([], "any", LIMIT)).resolves.toEqual([]);
      });
    });

    describe("touchUsage (DD-011)", () => {
      it("counts a recall and stamps when it happened", async () => {
        const row = await compressed({ summary: "pgvector was chosen" });

        await store.touchUsage([row.id]);

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });
        const updated = hits.find((hit) => hit.memory.id === row.id)?.memory;
        expect(updated?.recallCount).toBe(1);
        expect(updated?.lastRecalledAt).toBeInstanceOf(Date);
      });

      it("accumulates across calls", async () => {
        const row = await compressed({ summary: "pgvector was chosen" });

        await store.touchUsage([row.id]);
        await store.touchUsage([row.id]);

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });
        expect(hits.find((hit) => hit.memory.id === row.id)?.memory.recallCount).toBe(2);
      });

      it("tolerates an unknown id without failing", async () => {
        await expect(
          store.touchUsage(["00000000-0000-4000-8000-000000000999"]),
        ).resolves.toBeUndefined();
      });

      it("tolerates an empty list", async () => {
        await expect(store.touchUsage([])).resolves.toBeUndefined();
      });
    });

    describe("softDelete and restore (DD-012, DD-039)", () => {
      it("reports true once and false thereafter", async () => {
        const row = await store.insertRaw(newMemory());

        await expect(store.softDelete(row.id)).resolves.toBe(true);
        await expect(store.softDelete(row.id)).resolves.toBe(false);
      });

      it("reports false for an id nothing carries", async () => {
        await expect(
          store.softDelete("00000000-0000-4000-8000-000000000999"),
        ).resolves.toBe(false);
      });

      it("brings a deleted row back", async () => {
        const row = await compressed({ summary: "pgvector was chosen" });
        await store.softDelete(row.id);

        await expect(store.restore(row.id)).resolves.toBe(true);

        const hits = await store.searchLexical("pgvector", { limit: LIMIT });
        expect(hits.map((hit) => hit.memory.id)).toContain(row.id);
      });

      it("reports false for a row that was never deleted", async () => {
        const row = await store.insertRaw(newMemory());

        await expect(store.restore(row.id)).resolves.toBe(false);
      });

      it("reports false for an id nothing carries", async () => {
        await expect(store.restore("00000000-0000-4000-8000-000000000999")).resolves.toBe(false);
      });
    });

    describe("findEnhancementBacklog and recordEnhancementAttempt (DD-005, DD-041)", () => {
      it("claims a raw row", async () => {
        const row = await store.insertRaw(newMemory());

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).toContain(row.id);
      });

      it("claims a compressed row that still needs an embedding", async () => {
        const row = await compressed({}, null);

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).toContain(row.id);
      });

      it("leaves a fully enhanced row alone — this is what makes repair idempotent", async () => {
        const row = await compressed({}, vector(1));

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).not.toContain(row.id);
      });

      it("excludes a soft-deleted row", async () => {
        const row = await store.insertRaw(newMemory());
        await store.softDelete(row.id);

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).not.toContain(row.id);
      });

      it("returns oldest first", async () => {
        const first = await store.insertRaw(newMemory({ contentHash: "a" }));
        await tick();
        const second = await store.insertRaw(newMemory({ contentHash: "b" }));

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).toEqual([first.id, second.id]);
      });

      it("honors the limit", async () => {
        await store.insertRaw(newMemory({ contentHash: "a" }));
        await store.insertRaw(newMemory({ contentHash: "b" }));

        await expect(
          store.findEnhancementBacklog(1, NO_BACKOFF),
        ).resolves.toHaveLength(1);
      });

      it("counts an attempt and stamps when it happened", async () => {
        const row = await store.insertRaw(newMemory());

        await store.recordEnhancementAttempt(row.id);
        const [claimed] = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(claimed?.enhancementAttempts).toBe(1);
        expect(claimed?.lastAttemptAt).toBeInstanceOf(Date);
      });

      /* The starvation guard: without it, a row that always fails holds its slot in
         the oldest-first backlog forever. */
      it("stops claiming a row once it reaches the cap", async () => {
        const row = await store.insertRaw(newMemory());
        for (let attempt = 0; attempt < MAX_ENHANCEMENT_ATTEMPTS; attempt += 1) {
          await store.recordEnhancementAttempt(row.id);
        }

        const backlog = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(backlog.map((candidate) => candidate.id)).not.toContain(row.id);
      });

      /* DD-045. Without the wait, five consecutive passes inside five minutes spend a
         row's whole cap, and each of those retries costs a CPU-bound generation. */
      it("holds a just-attempted row back until its backoff elapses", async () => {
        const row = await store.insertRaw(newMemory());
        await store.recordEnhancementAttempt(row.id);

        const waiting = await store.findEnhancementBacklog(LIMIT, {
          maxAttempts: MAX_ENHANCEMENT_ATTEMPTS,
          retryBaseMs: 60_000,
        });
        // The same row under a base of zero: proves the exclusion is the wait and not
        // "any attempted row is gone", which the cap already covers.
        const elapsed = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(waiting.map((candidate) => candidate.id)).not.toContain(row.id);
        expect(elapsed.map((candidate) => candidate.id)).toContain(row.id);
      });

      /* The wait must *grow*, not merely exist: a predicate of
         `last_attempt_at <= now() - base` passes every other case in this suite. Base
         and sleep are chosen with a 4× margin — a one-attempt row waits 200ms and a
         four-attempt row waits 1.6s, and the query runs 400ms in (DD-045). */
      it("lengthens the wait with each attempt", async () => {
        const once = await store.insertRaw(newMemory({ contentHash: "once" }));
        const often = await store.insertRaw(newMemory({ contentHash: "often" }));
        await store.recordEnhancementAttempt(once.id);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await store.recordEnhancementAttempt(often.id);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        const backlog = await store.findEnhancementBacklog(LIMIT, {
          maxAttempts: MAX_ENHANCEMENT_ATTEMPTS,
          retryBaseMs: 100,
        });

        const claimed = backlog.map((candidate) => candidate.id);
        expect(claimed).toContain(once.id);
        expect(claimed).not.toContain(often.id);
      });

      /* DD-045: an uncounted failure still has to step aside, or a row whose model
         call times out is handed to every pass forever and aborts each one. */
      it("holds a deferred row back without charging it an attempt", async () => {
        const row = await store.insertRaw(newMemory());

        await store.deferEnhancement(row.id);

        const waiting = await store.findEnhancementBacklog(LIMIT, {
          maxAttempts: MAX_ENHANCEMENT_ATTEMPTS,
          retryBaseMs: 60_000,
        });
        const [claimed] = await store.findEnhancementBacklog(LIMIT, NO_BACKOFF);

        expect(waiting.map((candidate) => candidate.id)).not.toContain(row.id);
        expect(claimed?.enhancementAttempts).toBe(0);
        expect(claimed?.lastAttemptAt).toBeInstanceOf(Date);
      });

      /* DD-045: otherwise a row that historically struggled is one bad day from the
         cap forever, even after it eventually compressed. */
      it("clears the failure history when the row makes progress", async () => {
        const row = await store.insertRaw(newMemory());
        await store.recordEnhancementAttempt(row.id);
        await store.recordEnhancementAttempt(row.id);

        const updated = await store.applyEnhancement(row.id, {
          summary: "compressed at last",
          tags: [],
          embedding: vector(2),
          embeddingModel: "conformance-model",
        });

        expect(updated?.enhancementAttempts).toBe(0);
        expect(updated?.lastAttemptAt).toBeNull();
      });

      it("tolerates an attempt against an id nothing carries", async () => {
        await expect(
          store.recordEnhancementAttempt("00000000-0000-4000-8000-000000000999"),
        ).resolves.toBeUndefined();
      });
    });
  });
}
