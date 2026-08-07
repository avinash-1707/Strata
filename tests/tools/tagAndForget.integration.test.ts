import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRedisCache } from "../../src/cache/redis.js";
import type { Cache } from "../../src/cache/types.js";
import type { Config } from "../../src/config/env.js";
import { DEFAULT_RECALL_K } from "../../src/contracts/recall.js";
import type { ToolDeps } from "../../src/deps.js";
import type { Db } from "../../src/db/types.js";
import { createPgStore } from "../../src/store/pg/index.js";
import type { MemoryStore, RankedMemory, SearchOptions } from "../../src/store/types.js";
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
import { createRecordingLogger } from "../support/recordingLogger.js";

/**
 * Phase 10's behavioural criteria for `search_by_tag` and `forget`, against real
 * Postgres and real Redis with a fake model.
 *
 * "A forgotten memory never appears in any search path" is the one that needs a real
 * database: the filter is a `where` clause inside a view, so the fake store can only
 * ever confirm that the fake reimplemented it (DD-012, DD-032 item 7).
 */

/* Every seeded row gets this summary, so the query below matches all of them
   lexically and the assertions are decided by *which ids come back* rather than by
   ranking — the fake's vectors are pseudorandom. */
const COMPRESSED = {
  summary: "connection pool exhaustion stalled the nightly job",
  suggested_tags: ["pool"],
};

const QUERY = "connection pool exhaustion";

const SETUP_TIMEOUT_MS = 30_000;

function searchOptions(): SearchOptions {
  return { limit: DEFAULT_RECALL_K };
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

function rankedIds(hits: readonly RankedMemory[]): string[] {
  return hits.map((hit) => hit.memory.id);
}

if (PG_URL === undefined || REDIS_URL === undefined) {
  describe.skip("search_by_tag and forget, end to end", () => {
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
    const log = createRecordingLogger();
    cache = createRedisCache(config, log);
    ollama = createFakeOllama({ compression: COMPRESSED });
    background = createTrackingBackgroundRunner(log);
    deps = { store, cache, ollama, config, log, background };
  });

  afterEach(async () => {
    await background.settled();
    await cache.close();
  });

  async function seed(content: string, tags: readonly string[]): Promise<string> {
    const written = await remember({ content, tags: [...tags] }, deps);
    expect(written.status).toBe("compressed");
    return written.id;
  }

  describe("search_by_tag is a database-only path (DD-018)", () => {
    it("answers with a model that fails every call, and never calls it", async () => {
      const target = await seed("The pool ran dry overnight.", ["pool", "incident"]);
      await seed("Unrelated note about the vector store.", ["pgvector"]);

      // A fresh fake, so the counts below cannot be diluted by the seeding above, and
      // set to fail: if `search_by_tag` ever reaches for the model, this throws.
      const blind = createFakeOllama({ embed: "unavailable", generate: "unavailable" });
      const found = await searchByTag(
        { tags: ["incident"], match: "any", limit: 20 },
        { ...deps, ollama: blind },
      );

      expect(ids(found.results)).toEqual([target]);
      expect(blind.embedCalls).toEqual([]);
      expect(blind.generateCalls).toEqual([]);
    });
  });

  describe("forget answers honestly (DD-018)", () => {
    it("returns deleted:false for an id that was never stored", async () => {
      await expect(forget({ id: "00000000-0000-4000-8000-0000000000ff" }, deps)).resolves.toEqual({
        deleted: false,
      });
    });

    it("returns deleted:false the second time, so a repeat is not a second delete", async () => {
      const target = await seed("The pool ran dry overnight.", ["pool"]);

      await expect(forget({ id: target }, deps)).resolves.toEqual({ deleted: true });
      await expect(forget({ id: target }, deps)).resolves.toEqual({ deleted: false });
    });
  });

  describe("a forgotten memory never appears in any search path (DD-012)", () => {
    it("leaves lexical, semantic, tag and recall — and only it", async () => {
      const target = await seed("The pool ran dry overnight.", ["pool", "incident"]);
      const survivor = await seed("The pool was resized the next morning.", ["pool", "fix"]);
      const queryVector = (await ollama.embed(QUERY, "query")).vector;

      // The premise: every path can see it *before* the forget. Without this the
      // assertions below hold against a path that never returned it at all.
      expect(rankedIds(await store.searchLexical(QUERY, searchOptions()))).toContain(target);
      expect(rankedIds(await store.searchSemantic(queryVector, searchOptions()))).toContain(target);
      expect(ids(await store.searchByTag(["pool"], "any", 20))).toContain(target);

      await expect(forget({ id: target }, deps)).resolves.toEqual({ deleted: true });

      const lexical = rankedIds(await store.searchLexical(QUERY, searchOptions()));
      const semantic = rankedIds(await store.searchSemantic(queryVector, searchOptions()));
      const tagged = ids(await store.searchByTag(["pool"], "any", 20));
      const recalled = ids(
        (await recall({ query: QUERY, k: DEFAULT_RECALL_K, synthesize: false }, deps)).results,
      );

      for (const path of [lexical, semantic, tagged, recalled]) {
        expect(path).not.toContain(target);
        // The positive control: `not.toContain` is also true of an empty list, so
        // without this a filter that dropped everything would read as DD-012 working.
        expect(path).toContain(survivor);
      }
    });

    it("stays out of a duplicate check, so the same content can be stored again (DD-020)", async () => {
      const content = "The pool ran dry overnight.";
      const first = await seed(content, ["pool"]);
      await expect(forget({ id: first }, deps)).resolves.toEqual({ deleted: true });

      const second = await remember({ content, tags: ["pool"] }, deps);

      // Not the old id handed back: the partial unique index is over live rows only,
      // which is what makes a forgotten memory re-rememberable rather than a conflict.
      expect(second.id).not.toBe(first);
    });
  });
}
