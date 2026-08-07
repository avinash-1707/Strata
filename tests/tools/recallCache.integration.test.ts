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
import type { MemoryStore } from "../../src/store/types.js";
import { forget } from "../../src/tools/forget.js";
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
    await cache.close();
  });

  /** Returns the id of a durable, compressed, embedded memory. */
  async function seed(content: string, tags: readonly string[]): Promise<string> {
    const written = await remember({ content, tags: [...tags] }, deps);
    expect(written.status).toBe("compressed");
    return written.id;
  }

  async function recallCountOf(content: string): Promise<number> {
    const row = await store.findLiveByContentHash(contentHash(content));
    if (row === undefined) {
      throw new Error("the seeded memory is gone; the test arranged the wrong state");
    }
    return row.recallCount;
  }

  describe("a forget invalidates the cache it would otherwise be served from (DD-010)", () => {
    it("does not return the forgotten memory to an identical repeat query", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      await seed(CONTENT_B, ["pgvector"]);

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

      /* The pre-forget generation is still physically in Redis and still names the
         forgotten memory. Only the version prefix makes it unreachable — which is
         the whole of DD-010, and is invisible if you assert on the tool output alone. */
      const stillThere = await raw.get(staleKey);
      expect(stillThere).toContain(idA);
    });

    it("keeps serving from cache when the forget matched nothing", async () => {
      await seed(CONTENT_A, ["pool"]);
      await recall(ask(), deps);
      const before = ollama.embedCalls.length;

      await expect(
        forget({ id: "00000000-0000-4000-8000-0000000000ff" }, deps),
      ).resolves.toEqual({ deleted: false });

      await recall(ask(), deps);

      // No bump, so the second recall is still a hit: it never embedded the query.
      expect(ollama.embedCalls.length).toBe(before);
    });
  });

  describe("usage tracking survives the cache (DD-011)", () => {
    it("increments recall_count on a cache hit, not just on a miss", async () => {
      await seed(CONTENT_A, ["pool"]);

      await recall(ask(), deps);
      await background.settled();
      const afterMiss = await recallCountOf(CONTENT_A);
      expect(afterMiss).toBe(1);

      const embedsBefore = ollama.embedCalls.length;
      await recall(ask(), deps);
      // Proves the second call was served from cache: a miss embeds the query.
      expect(ollama.embedCalls.length).toBe(embedsBefore);

      await background.settled();
      await expect(recallCountOf(CONTENT_A)).resolves.toBe(afterMiss + 1);
      expect(background.failures).toEqual([]);
    });
  });

  describe("cache keys separate the requests that must not share an answer", () => {
    it("does not serve a k=8 entry to a k=50 request", async () => {
      await seed(CONTENT_A, ["pool"]);
      await recall(ask({ k: 8 }), deps);
      const embedsBefore = ollama.embedCalls.length;

      await recall(ask({ k: 50 }), deps);

      expect(ollama.embedCalls.length).toBe(embedsBefore + 1);
    });

    it("never answers synthesize:false out of a synthesized entry", async () => {
      await seed(CONTENT_A, ["pool"]);
      const synthesized = await recall(ask({ synthesize: true }), deps);
      expect(synthesized.answer).toBeDefined();
      const generatesBefore = ollama.generateCalls.length;

      const plain = await recall(ask({ synthesize: false }), deps);

      expect(plain).not.toHaveProperty("answer");
      // And it got there without asking the model, so the absence is the key's
      // doing rather than a synthesis that happened to fail.
      expect(ollama.generateCalls.length).toBe(generatesBefore);
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
      const downCache = createRedisCache({ ...config, REDIS_URL: DEAD_REDIS }, downLog);
      const downDeps: ToolDeps = {
        store,
        cache: downCache,
        ollama,
        config,
        log: downLog,
        background: createTrackingBackgroundRunner(downLog),
      };

      try {
        const written = await remember(
          { content: CONTENT_A, tags: ["pool"] },
          downDeps,
        );
        expect(written.status).toBe("compressed");

        const found = await recall(ask(), downDeps);
        expect(ids(found.results)).toContain(written.id);

        const tagged = await searchByTag({ tags: ["pool"], match: "any", limit: 20 }, downDeps);
        expect(ids(tagged.results)).toContain(written.id);

        await expect(forget({ id: written.id }, downDeps)).resolves.toEqual({ deleted: true });

        // Degrading silently is the failure mode: the corpus keeps working while
        // nobody learns the cache is gone.
        const warnings = downLog.messages("warn").join(" ");
        expect(warnings).toContain("corpus version bump failed");
        expect(warnings).toContain("corpus version unavailable");
      } finally {
        await downCache.close();
      }
    }, SETUP_TIMEOUT_MS);
  });

  describe("flushing Redis costs latency, never data", () => {
    it("answers the same recall from Postgres after a FLUSHALL", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      const before = await recall(ask(), deps);
      expect(ids(before.results)).toContain(idA);

      await raw.flushAll();

      const after = await recall(ask(), deps);
      expect(ids(after.results)).toEqual(ids(before.results));
      // The counter went with the entries it scopes. Losing it costs a cache
      // generation and nothing else — which is only true because they share a
      // lifetime (DD-044, architecture § Cache layer).
      await expect(cache.getCorpusVersion()).resolves.toBe(0);
    });

    it("does not resurrect a forgotten memory when the counter resets", async () => {
      const idA = await seed(CONTENT_A, ["pool"]);
      await seed(CONTENT_B, ["pgvector"]);
      await recall(ask(), deps);
      await forget({ id: idA }, deps);

      await raw.flushAll();

      const after = await recall(ask(), deps);
      expect(ids(after.results)).not.toContain(idA);
    });
  });
}
