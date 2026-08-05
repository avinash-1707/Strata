import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRedisCache } from "../../src/cache/redis.js";
import { composeRecallKey } from "../../src/cache/key.js";
import type { Cache, RecallKey } from "../../src/cache/types.js";
import type { RecallOutput } from "../../src/contracts/recall.js";
import { loadConfig } from "../../src/config/env.js";
import { REDIS_URL } from "../support/integrationDb.js";
import { createRecordingLogger } from "../support/recordingLogger.js";
import type { RecordingLogger } from "../support/recordingLogger.js";

const KEY: RecallKey = { query: "postgres pool", k: 8, synthesize: true };

const VALUE: RecallOutput = {
  answer: "an answer",
  results: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      summary: "a cached result",
      tags: ["postgres"],
      score: 0.03,
      similarity: 0.9,
    },
  ],
};

function cacheConfig(redisUrl: string): Parameters<typeof createRedisCache>[0] {
  return loadConfig({
    POSTGRES_URL: "postgres://unused",
    REDIS_URL: redisUrl,
    OLLAMA_URL: "http://127.0.0.1:1",
    EMBEDDING_MODEL: "nomic-embed-text",
    INSTRUCT_MODEL: "qwen2.5:3b-instruct",
  });
}

if (REDIS_URL === undefined) {
  describe.skip("redis cache against a real Redis", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_REDIS_URL unset)", () => undefined);
  });
} else {
  const url = REDIS_URL;
  let cache: Cache;
  let log: RecordingLogger;
  // A raw client, for arranging states the Cache interface rightly cannot express.
  let raw: ReturnType<typeof createClient>;

  beforeAll(async () => {
    raw = createClient({ url });
    await raw.connect();
  });

  afterAll(async () => {
    await cache.close();
    raw.destroy();
  });

  beforeEach(async () => {
    await raw.flushAll();
    log = createRecordingLogger();
    cache = createRedisCache(cacheConfig(url), log);
  });

  describe("redis cache: corpus version (DD-010)", () => {
    it("reads 0 before any mutation, so the first bump still invalidates", async () => {
      await expect(cache.getCorpusVersion()).resolves.toBe(0);
    });

    it("advances on every bump", async () => {
      await cache.bumpCorpusVersion();
      await expect(cache.getCorpusVersion()).resolves.toBe(1);
      await cache.bumpCorpusVersion();
      await expect(cache.getCorpusVersion()).resolves.toBe(2);
    });
  });

  describe("redis cache: recall entries", () => {
    it("round-trips a recall output under the same version and key", async () => {
      await cache.setRecall(1, KEY, VALUE);

      await expect(cache.getRecall(1, KEY)).resolves.toEqual(VALUE);
    });

    it("misses across a version bump — a forget must forget (DD-010)", async () => {
      await cache.setRecall(1, KEY, VALUE);

      await expect(cache.getRecall(2, KEY)).resolves.toBeUndefined();
    });

    it("keeps k=8 and k=50 apart, and synthesize:false away from a cached answer", async () => {
      await cache.setRecall(1, KEY, VALUE);

      await expect(cache.getRecall(1, { ...KEY, k: 50 })).resolves.toBeUndefined();
      await expect(cache.getRecall(1, { ...KEY, synthesize: false })).resolves.toBeUndefined();
    });

    it("expires: every entry carries a TTL, never immortality", async () => {
      await cache.setRecall(1, KEY, VALUE);

      const ttl = await raw.ttl(composeRecallKey(1, KEY));
      expect(ttl).toBeGreaterThan(0);
    });

    it("treats an unreadable entry as a miss and says so", async () => {
      await raw.set(composeRecallKey(1, KEY), "{ not json");

      await expect(cache.getRecall(1, KEY)).resolves.toBeUndefined();
      expect(log.messages("warn").join(" ")).toContain("unreadable");
    });

    it("survives FLUSHALL with latency, never an error", async () => {
      await cache.setRecall(1, KEY, VALUE);
      await raw.flushAll();

      await expect(cache.getRecall(1, KEY)).resolves.toBeUndefined();
      await expect(cache.getCorpusVersion()).resolves.toBe(0);
    });
  });

  describe("redis cache: failure shape", () => {
    it("throws CACHE_UNAVAILABLE, promptly, when nothing listens at the address", async () => {
      const dead = createRedisCache(cacheConfig("redis://127.0.0.1:1"), createRecordingLogger());
      const started = Date.now();

      await expect(dead.getRecall(1, KEY)).rejects.toMatchObject({ code: "CACHE_UNAVAILABLE" });
      // "Promptly" is the requirement: a cache that hangs is worse than one that
      // is down, because recall waits on it before searching.
      expect(Date.now() - started).toBeLessThan(5_000);

      await dead.close();
    });
  });

  describe("the container itself (architecture § Cache layer)", () => {
    it("runs without persistence, so the counter and entries share a lifetime", async () => {
      const save = await raw.configGet("save");
      const appendonly = await raw.configGet("appendonly");

      expect(save["save"]).toBe("");
      expect(appendonly["appendonly"]).toBe("no");
    });
  });
}
