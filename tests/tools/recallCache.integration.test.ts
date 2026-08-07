import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { composeRecallKey } from "../../src/cache/key.js";
import { createRedisCache } from "../../src/cache/redis.js";
import type { Cache } from "../../src/cache/types.js";
import type { Config } from "../../src/config/env.js";
import { DEFAULT_RECALL_K } from "../../src/contracts/recall.js";
import type { RecallInput } from "../../src/contracts/recall.js";
import type { ToolDeps } from "../../src/deps.js";
import type { Db } from "../../src/db/types.js";
import { contentHash } from "../../src/hash.js";
import { createPgStore } from "../../src/store/pg/index.js";
import type { MemoryRecord, MemoryStore } from "../../src/store/types.js";
import { forget, restore } from "../../src/tools/forget.js";
import { health } from "../../src/tools/health.js";
import { recall } from "../../src/tools/recall.js";
import { remember } from "../../src/tools/remember.js";
import { searchByTag } from "../../src/tools/searchByTag.js";
import type { TrackingBackgroundRunner } from "../fakes/fakeDeps.js";
import { createTrackingBackgroundRunner } from "../fakes/fakeDeps.js";
import type { FakeOllama } from "../fakes/fakeOllama.js";
import { createFakeOllama } from "../fakes/fakeOllama.js";
import {
  PG_URL,
  REDIS_URL,
  connectMigrated,
  integrationConfig,
  truncateMemories,
} from "../support/integrationDb.js";
import type { RecordingLogger } from "../support/recordingLogger.js";
import { createRecordingLogger } from "../support/recordingLogger.js";

/**
 * Phase 9. The cache *layer* is covered by `tests/cache/redisCache.integration.test.ts`;
 * this file asserts the properties Phase 9 states at the **tool** level, where a
 * version bump, a key, and a fire-and-forget usage update have to line up across
 * three components at once. Real Postgres, real Redis, a fake model — the fake is
 * the split-machine constraint (DD-027), not a shortcut: nothing here depends on
 * what the model says.
 *
 * The fake's vectors are pseudorandom, so semantic *rank* is meaningless. Every
 * assertion below is about set membership by id, never about ordering.
 */

const CONTENT_A = "The connection pool was exhausted, so the nightly job timed out.";
const CONTENT_B = "We chose pgvector over Qdrant because it lives in the same database.";

/** Long enough for the boot migration plus the model-free seeding. */
const SETUP_TIMEOUT_MS = 30_000;

function ask(overrides: Partial<RecallInput> = {}): RecallInput {
  return {
    query: "what happened to the connection pool",
    k: DEFAULT_RECALL_K,
    synthesize: true,
    ...overrides,
  };
}

function ids(results: readonly { id: string }[]): string[] {
  return results.map((result) => result.id);
}

if (PG_URL === undefined || REDIS_URL === undefined) {
  describe.skip("recall cache, end to end", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL/REDIS_URL unset)", () => undefined);
  });
} else {
  const pgUrl = PG_URL;
  const redisUrl = REDIS_URL;
  const config: Config = integrationConfig(pgUrl);

  let db: Db;
  let store: MemoryStore;
  let raw: ReturnType<typeof createClient>;

  let cache: Cache;
  let ollama: FakeOllama;
  let background: TrackingBackgroundRunner;
  let log: RecordingLogger;
  let deps: ToolDeps;

  beforeAll(async () => {
    db = await connectMigrated(pgUrl);
    store = createPgStore(db);
    raw = createClient({ url: redisUrl });
    await raw.connect();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db.close();
    raw.destroy();
  });

  beforeEach(async () => {
    await truncateMemories(db);
    await raw.flushAll();
    log = createRecordingLogger();
    cache = createRedisCache(config, log);
    ollama = createFakeOllama();
    background = createTrackingBackgroundRunner(log);
    deps = { store, cache, ollama, config, log, background };
  });

  afterEach(async () => {
    // Before the next truncate: an in-flight `touchUsage` is an uncommitted UPDATE,
    // and `truncate` takes ACCESS EXCLUSIVE, so leaving one running turns the next
    // test's setup into a lock wait that times out somewhere unrelated.
    await background.settled();
    await cache.close();
  });

  /** Returns the id of a durable, compressed, embedded memory. */
  async function seed(
    content: string,
    tags: readonly string[],
    sessionId?: string,
  ): Promise<string> {
    const written = await remember(
      {
        content,
        tags: [...tags],
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      },
      deps,
    );
    expect(written.status).toBe("compressed");
    return written.id;
  }

  /**
   * Only the query embeddings. Seeding pushes `document` embeds onto the same array,
   * so a raw length makes the hit/miss inference depend on nothing else having run.
   */
  function queryEmbeds(): number {
    return ollama.embedCalls.filter((call) => call.kind === "query").length;
  }

  async function liveRow(content: string): Promise<MemoryRecord> {
    const row = await store.findLiveByContentHash(contentHash(content));
    if (row === undefined) {
      throw new Error("the seeded memory is gone; the test arranged the wrong state");
    }
    return row;
  }

  async function recallCountOf(content: string): Promise<number> {
    return (await liveRow(content)).recallCount;
  }

  async function idOf(content: string): Promise<string> {
    return (await liveRow(content)).id;
  }

  describe("a forget invalidates the cache it would otherwise be served from (DD-010)", () => {
    it("does not return the forgotten memory to an identical repeat query", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      const idB = await seed(CONTENT_B, ["pgvector"]);

      const first = await recall(ask(), deps);
      expect(ids(first.results)).toContain(idA);

      // The entry this test is about must actually exist, or a forget that
      // "works" proves only that nothing was cached.
      const staleVersion = await cache.getCorpusVersion();
      const staleKey = composeRecallKey(staleVersion, {
        query: ask().query,
        k: DEFAULT_RECALL_K,
        synthesize: true,
      });
      await expect(raw.exists(staleKey)).resolves.toBe(1);

      await expect(forget({ id: idA }, deps)).resolves.toEqual({ deleted: true });

      const second = await recall(ask(), deps);
      expect(ids(second.results)).not.toContain(idA);
      // The positive control: `not.toContain` also holds over an empty list, so a
      // forget that over-deleted, or a recall that stopped answering, would read as
      // DD-010 working.
      expect(ids(second.results)).toContain(idB);

      /* The pre-forget generation is still physically in Redis and still names the
         forgotten memory. Only the version prefix makes it unreachable — which is
         the whole of DD-010, and is invisible if you assert on the tool output alone. */
      const stillThere = await raw.get(staleKey);
      expect(stillThere).toContain(idA);
    });

    it("keeps serving from cache when the forget matched nothing", async () => {
      await seed(CONTENT_A, ["pool"]);
      await recall(ask(), deps);
      const before = queryEmbeds();

      await expect(
        forget({ id: "00000000-0000-4000-8000-0000000000ff" }, deps),
      ).resolves.toEqual({ deleted: false });

      await recall(ask(), deps);

      // No bump, so the second recall is still a hit: it never embedded the query.
      expect(queryEmbeds()).toBe(before);
    });
  });

  describe("usage tracking survives the cache (DD-011)", () => {
    it("increments recall_count on a cache hit, not just on a miss", async () => {
      await seed(CONTENT_A, ["pool"], "session-a");
      /* Out of scope for every recall below, so it must never be touched. Without a
         row the query cannot reach, a `touchUsage` that lost its id predicate passes
         this test. The scope filter does the excluding, not the ranking: the fake's
         vectors are pseudorandom, so a `k=1` cut would decide it by luck. */
      await seed(CONTENT_B, ["pgvector"], "session-b");
      const scoped = ask({ session_id: "session-a" });

      const miss = await recall(scoped, deps);
      expect(ids(miss.results)).toEqual([await idOf(CONTENT_A)]);
      await background.settled();
      const afterMiss = await recallCountOf(CONTENT_A);
      expect(afterMiss).toBe(1);

      const embedsBefore = queryEmbeds();
      await recall(scoped, deps);
      // Proves the second call was served from cache: a miss embeds the query.
      expect(queryEmbeds()).toBe(embedsBefore);

      await background.settled();
      await expect(recallCountOf(CONTENT_A)).resolves.toBe(afterMiss + 1);
      await expect(recallCountOf(CONTENT_B)).resolves.toBe(0);
      expect(background.failures).toEqual([]);
    });
  });

  describe("cache keys separate the requests that must not share an answer", () => {
    /** Asserts the entry a request of this shape must have left behind. */
    async function expectCached(key: { k: number; synthesize: boolean }): Promise<void> {
      const version = await cache.getCorpusVersion();
      const composed = composeRecallKey(version, { query: ask().query, ...key });
      await expect(raw.exists(composed)).resolves.toBe(1);
    }

    it("does not serve a k=8 entry to a k=50 request", async () => {
      await seed(CONTENT_A, ["pool"]);
      await recall(ask({ k: 8 }), deps);
      await expectCached({ k: 8, synthesize: true });
      const embedsBefore = queryEmbeds();

      await recall(ask({ k: 50 }), deps);

      expect(queryEmbeds()).toBe(embedsBefore + 1);
    });

    it("never answers synthesize:false out of a synthesized entry", async () => {
      await seed(CONTENT_A, ["pool"]);
      const synthesized = await recall(ask({ synthesize: true }), deps);
      expect(synthesized.answer).toBeDefined();
      // The premise: there *is* a cached answer for this query to be served wrongly.
      await expectCached({ k: DEFAULT_RECALL_K, synthesize: true });
      const embedsBefore = queryEmbeds();

      const plain = await recall(ask({ synthesize: false }), deps);

      expect(plain).not.toHaveProperty("answer");
      // Not a cheaper answer from the same entry: a separate key, hence a real miss.
      expect(queryEmbeds()).toBe(embedsBefore + 1);
    });
  });

  describe("Redis absent (architecture § Cache layer)", () => {
    /**
     * A dead address, not a stopped container: the suite is serialized over one
     * shared stack, so stopping Redis here would break every file after this one.
     * Connection-refused is the shape a stopped Redis presents to a client that
     * has to reconnect; what this cannot cover is a connection dropped mid-command.
     */
    const DEAD_REDIS = "redis://127.0.0.1:1";

    it("serves every tool, and says so", async () => {
      const downLog = createRecordingLogger();
      const downConfig: Config = { ...config, REDIS_URL: DEAD_REDIS };
      const downCache = createRedisCache(downConfig, downLog);
      const downBackground = createTrackingBackgroundRunner(downLog);
      const downDeps: ToolDeps = {
        store,
        cache: downCache,
        ollama,
        config: downConfig,
        log: downLog,
        background: downBackground,
      };

      try {
        const written = await remember({ content: CONTENT_A, tags: ["pool"] }, downDeps);
        expect(written.status).toBe("compressed");

        const found = await recall(ask(), downDeps);
        expect(ids(found.results)).toContain(written.id);

        // A guard, not evidence: `search_by_tag` never touches the cache by design,
        // so this is here to catch someone later giving it one.
        const tagged = await searchByTag({ tags: ["pool"], match: "any", limit: 20 }, downDeps);
        expect(ids(tagged.results)).toContain(written.id);

        await expect(health({}, downDeps)).resolves.toMatchObject({
          cache: "down",
          corpus_version: null,
        });

        await expect(forget({ id: written.id }, downDeps)).resolves.toEqual({ deleted: true });
        // The other bumping mutation (DD-039), and the one most likely to be missed.
        await expect(restore({ id: written.id }, downDeps)).resolves.toEqual({ restored: true });

        // Degrading silently is the failure mode: the corpus keeps working while
        // nobody learns the cache is gone.
        const warnings = downLog.messages("warn").join(" ");
        expect(warnings).toContain("corpus version bump failed");
        expect(warnings).toContain("corpus version unavailable");
      } finally {
        await downBackground.settled();
        await downCache.close();
      }
    }, SETUP_TIMEOUT_MS);
  });

  describe("flushing Redis costs latency, never data", () => {
    it("answers the same recall from Postgres after a FLUSHALL", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      const idB = await seed(CONTENT_B, ["pgvector"]);
      const before = await recall(ask(), deps);
      expect(ids(before.results)).toEqual(expect.arrayContaining([idA, idB]));

      await raw.flushAll();

      const after = await recall(ask(), deps);
      // Sorted: the file asserts membership, never order. Semantic order over the
      // fake's vectors is arbitrary, and HNSW's is only approximately sorted.
      expect([...ids(after.results)].sort()).toEqual([...ids(before.results)].sort());
      // The counter went with the entries it scopes. Losing it costs a cache
      // generation and nothing else — which is only true because they share a
      // lifetime (DD-044, architecture § Cache layer).
      await expect(cache.getCorpusVersion()).resolves.toBe(0);
    });

    /**
     * A cold-path regression guard, not a measurement: `FLUSHALL` takes the entries
     * *and* the counter, so nothing survives to be resurrected and no plausible
     * mutation of the cache makes this fail. The hazard DD-044 and DD-048 actually
     * name is **asymmetric** loss — the counter evicted while entries live — and
     * that one is closed by Redis configuration (`noeviction`), not by any code this
     * suite can exercise.
     */
    it("still excludes a forgotten memory on the cold path after a FLUSHALL", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      const idB = await seed(CONTENT_B, ["pgvector"]);
      await recall(ask(), deps);
      await forget({ id: idA }, deps);

      await raw.flushAll();

      const after = await recall(ask(), deps);
      expect(ids(after.results)).not.toContain(idA);
      expect(ids(after.results)).toContain(idB);
    });
  });
}
