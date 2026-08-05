import { createClient } from "redis";

import { RECALL_CACHE_TTL_SECONDS } from "../config/budgets.js";
import type { Config } from "../config/env.js";
import { recallOutputSchema } from "../contracts/recall.js";
import type { RecallOutput } from "../contracts/recall.js";
import { StrataError, describeUnknown, wrapError } from "../errors.js";
import type { Logger } from "../logger.js";
import { CORPUS_VERSION_KEY, composeRecallKey } from "./key.js";
import type { Cache, RecallKey } from "./types.js";

/**
 * A cache read slower than this is a cache that is down: the whole point of the
 * cache is to be faster than the search it fronts, and every caller degrades on
 * failure anyway (DD-005).
 */
const OPERATION_TIMEOUT_MS = 2_000;

/** Waiting longer than this to (re)connect just delays the CACHE_UNAVAILABLE verdict. */
const CONNECT_TIMEOUT_MS = 2_000;

/** Backoff cap between reconnect attempts while Redis is away. */
const RECONNECT_CAP_MS = 3_000;

function bounded<T>(work: Promise<T>, operation: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new StrataError("CACHE_UNAVAILABLE", `cache ${operation} timed out`, {
            details: { timeoutMs: OPERATION_TIMEOUT_MS },
          }),
        );
      }, OPERATION_TIMEOUT_MS);
      // Never holds the process open for a race the real operation already won.
      timer.unref();
    }),
  ]);
}

/**
 * The real recall cache. Holds nothing durable: every method throws only
 * `CACHE_UNAVAILABLE`, and every caller treats that as "serve without the cache".
 */
export function createRedisCache(config: Config, log: Logger): Cache {
  const client = createClient({
    url: config.REDIS_URL,
    // Commands fail fast while disconnected instead of queueing forever; a queued
    // command outliving its recall would answer a request nobody is waiting on.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(retries * 100, RECONNECT_CAP_MS),
    },
  });

  // Without a listener, a dropped connection is an unhandled 'error' event that
  // kills the process. The client reconnects on its own; this is just the report.
  client.on("error", (error: unknown) => {
    log.warn({ error: describeUnknown(error) }, "redis connection error");
  });

  // Boot must not depend on the cache being up (DD-005): the connect runs in the
  // background. The reconnect strategy never gives up, so this promise may never
  // settle — nothing below awaits it unconditionally.
  void client.connect().catch((error: unknown) => {
    log.warn({ error: describeUnknown(error) }, "redis connect failed");
  });

  // Settles on the *first* connection outcome, success or failure. Lets an op in
  // the boot window wait briefly instead of failing spuriously, while an op after
  // that fails in microseconds when Redis is away — without this, every call on a
  // down Redis would burn the full OPERATION_TIMEOUT_MS, and a recall does three.
  const firstAttempt = new Promise<void>((resolve) => {
    client.once("ready", () => {
      resolve();
    });
    client.once("error", () => {
      resolve();
    });
  });

  async function op<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (!client.isReady) {
      await bounded(firstAttempt, operation);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isReady is a live getter that flips during the await; TS keeps the stale narrowing across it
      if (!client.isReady) {
        throw new StrataError(
          "CACHE_UNAVAILABLE",
          `cache ${operation} skipped: redis is not connected`,
        );
      }
    }
    return bounded(work(), operation);
  }

  return {
    async getCorpusVersion() {
      try {
        const raw = await op("version read", () => client.get(CORPUS_VERSION_KEY));
        // Missing key → 0, so the first bump (INCR → 1) still invalidates: a get
        // that defaulted to 1 would collide with that first post-mutation INCR (DD-044).
        if (raw === null) {
          return 0;
        }
        const version = Number.parseInt(raw, 10);
        // A corrupted counter behaves like a missing one; NaN would compose
        // "recall:vNaN:…" keys and then make the INCR invalidation path throw.
        return Number.isInteger(version) && version >= 0 ? version : 0;
      } catch (cause) {
        throw wrapError("CACHE_UNAVAILABLE", "could not read the corpus version", cause);
      }
    },

    async bumpCorpusVersion() {
      try {
        await op("version bump", () => client.incr(CORPUS_VERSION_KEY));
      } catch (cause) {
        throw wrapError("CACHE_UNAVAILABLE", "could not bump the corpus version", cause);
      }
    },

    async getRecall(corpusVersion, key: RecallKey) {
      const composed = composeRecallKey(corpusVersion, key);
      let raw: string | null;
      try {
        raw = await op("recall read", () => client.get(composed));
      } catch (cause) {
        throw wrapError("CACHE_UNAVAILABLE", "could not read the recall cache", cause);
      }
      if (raw === null) {
        return undefined;
      }
      // Validated on the way out, not trusted: the payload crossed a process
      // boundary and an unparseable entry must behave as a miss, never a crash.
      try {
        const parsed: unknown = JSON.parse(raw);
        return recallOutputSchema.parse(parsed);
      } catch (cause) {
        log.warn(
          { error: describeUnknown(cause) },
          "recall cache entry was unreadable; treating as a miss",
        );
        // Best-effort eviction: left in place, the poison entry would re-fail
        // every identical recall for the full TTL.
        await client.del(composed).catch((error: unknown) => {
          log.debug({ error: describeUnknown(error) }, "could not evict the unreadable entry");
        });
        return undefined;
      }
    },

    async setRecall(corpusVersion, key: RecallKey, value: RecallOutput) {
      try {
        await op("recall write", () =>
          client.setEx(
            composeRecallKey(corpusVersion, key),
            RECALL_CACHE_TTL_SECONDS,
            JSON.stringify(value),
          ),
        );
      } catch (cause) {
        throw wrapError("CACHE_UNAVAILABLE", "could not write the recall cache", cause);
      }
    },

    close() {
      try {
        // destroy(), not close(): close() waits for a live connection's pending
        // replies, but shutdown must also work while Redis is down or reconnecting.
        client.destroy();
      } catch (cause) {
        // Never rejects: teardown of an optimization must not block teardown of
        // the durable resources behind it, and destroy() throws on a client that
        // was already destroyed or never connected.
        log.debug({ error: describeUnknown(cause) }, "redis client was already closed");
      }
      return Promise.resolve();
    },
  };
}
