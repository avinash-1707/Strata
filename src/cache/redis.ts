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
  // background and every operation awaits it *inside its own time budget* — so a
  // call during the brief connecting window waits instead of failing spuriously,
  // and a call while Redis is truly away still fails within OPERATION_TIMEOUT_MS.
  const ready: Promise<void> = client.connect().then(
    () => undefined,
    (cause: unknown) => {
      throw wrapError("CACHE_UNAVAILABLE", "redis connection failed", cause);
    },
  );
  // Handled here so an unused cache cannot surface an unhandled rejection; the
  // per-operation awaits still observe the failure through `ready` itself.
  ready.catch((error: unknown) => {
    log.warn({ error: describeUnknown(error) }, "redis connection failed");
  });

  async function op<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return bounded(
      (async () => {
        await ready;
        return work();
      })(),
      operation,
    );
  }

  return {
    async getCorpusVersion() {
      try {
        const raw = await op("version read", () => client.get(CORPUS_VERSION_KEY));
        // Missing key → 0, so the first bump (INCR → 1) still invalidates: a get
        // that defaulted to 1 would collide with that first post-mutation INCR.
        return raw === null ? 0 : Number.parseInt(raw, 10);
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
      let raw: string | null;
      try {
        raw = await op("recall read", () => client.get(composeRecallKey(corpusVersion, key)));
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
        return Promise.resolve();
      } catch (cause) {
        return Promise.reject(
          wrapError("CACHE_UNAVAILABLE", "could not close the redis client", cause),
        );
      }
    },
  };
}
