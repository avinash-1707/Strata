import { composeRecallKey } from "../../src/cache/key.js";
import type { Cache } from "../../src/cache/types.js";
import type { RecallOutput } from "../../src/contracts/recall.js";
import { StrataError } from "../../src/errors.js";

/**
 * An in-memory `Cache` that composes keys the same way the Redis implementation
 * must. It exposes the composed key strings so that DD-010's requirements —
 * corpus version, `k`, and `synthesize` all participating — are asserted directly
 * rather than inferred from hit/miss behavior.
 */
export interface FakeCache extends Cache {
  /** Every key written, in insertion order. */
  readonly keys: readonly string[];
  /**
   * Method names invoked, in order. Needed because hits/misses only move on
   * `getRecall`, so their sum cannot distinguish "was not called" from "was called
   * but read nothing" — which makes any assertion built on it unfalsifiable.
   */
  readonly calls: readonly (keyof Cache)[];
  readonly hits: number;
  readonly misses: number;
  /** Simulates Redis being down: every method rejects with CACHE_UNAVAILABLE. */
  setDown(down: boolean): void;
  /** Fails one method only, e.g. reads work but the version bump does not. */
  setFailure(method: keyof Cache, error: StrataError | undefined): void;
}

export interface FakeCacheOptions {
  readonly down?: boolean;
  readonly initialVersion?: number;
}

export function createFakeCache(options: FakeCacheOptions = {}): FakeCache {
  const entries = new Map<string, RecallOutput>();
  const keys: string[] = [];
  const failures = new Map<keyof Cache, StrataError>();
  const calls: (keyof Cache)[] = [];
  let version = options.initialVersion ?? 1;
  let down = options.down ?? false;
  let hits = 0;
  let misses = 0;

  /**
   * Async so a failure surfaces as a rejected promise, exactly as the Redis client
   * would. A synchronous throw would escape a `Promise.all` before its siblings
   * were even started, which is not how the real cache fails.
   */
  async function enter(method: keyof Cache): Promise<void> {
    calls.push(method);
    await Promise.resolve();
    if (down) {
      throw new StrataError("CACHE_UNAVAILABLE", `fake cache is down (${method})`);
    }
    const failure = failures.get(method);
    if (failure !== undefined) {
      throw failure;
    }
  }

  return {
    get keys() {
      return keys;
    },
    get calls() {
      return calls;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },

    setDown(next) {
      down = next;
    },

    setFailure(method, error) {
      if (error === undefined) {
        failures.delete(method);
      } else {
        failures.set(method, error);
      }
    },

    async getCorpusVersion() {
      await enter("getCorpusVersion");
      return version;
    },

    async bumpCorpusVersion() {
      await enter("bumpCorpusVersion");
      version += 1;
    },

    async getRecall(corpusVersion, key) {
      await enter("getRecall");
      const found = entries.get(composeRecallKey(corpusVersion, key));
      if (found === undefined) {
        misses += 1;
      } else {
        hits += 1;
      }
      return found;
    },

    async setRecall(corpusVersion, key, value) {
      await enter("setRecall");
      const composed = composeRecallKey(corpusVersion, key);
      entries.set(composed, value);
      keys.push(composed);
    },

    close() {
      return Promise.resolve();
    },
  };
}
