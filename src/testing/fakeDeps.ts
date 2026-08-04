import type { Config } from "../config.js";
import { describeUnknown } from "../errors.js";
import type { Logger } from "../logger.js";
import { createSilentLogger } from "../logger.js";
import type { BackgroundRunner, ToolDeps } from "../mcp/deps.js";
import type { FakeCache, FakeCacheOptions } from "./fakeCache.js";
import { createFakeCache } from "./fakeCache.js";
import type { FakeOllama, FakeOllamaOptions } from "./fakeOllama.js";
import { createFakeOllama } from "./fakeOllama.js";
import type { FakeStore, FakeStoreOptions } from "./fakeStore.js";
import { createFakeStore } from "./fakeStore.js";

/**
 * A `ToolDeps` whose parts are all fakes, with each fake still reachable for
 * assertions. Every dependency is constructed here and passed in — no
 * module-level singleton exists to reset between tests.
 */
export interface FakeDeps extends ToolDeps {
  readonly store: FakeStore;
  readonly cache: FakeCache;
  readonly ollama: FakeOllama;
  readonly background: TrackingBackgroundRunner;
}

/**
 * A `BackgroundRunner` that also lets a test await what it started. DD-011's usage
 * update is deliberately off the response path, so without this a test would have
 * to poll or sleep to observe it.
 */
export interface TrackingBackgroundRunner extends BackgroundRunner {
  /** Resolves once every task started so far has settled. */
  settled(): Promise<void>;
  readonly labels: readonly string[];
  readonly failures: readonly { label: string; error: unknown }[];
}

export interface FakeDepsOptions {
  readonly store?: FakeStoreOptions;
  readonly cache?: FakeCacheOptions;
  readonly ollama?: FakeOllamaOptions;
  readonly config?: Partial<Config>;
  readonly log?: Logger;
}

/** Placeholder values only. Nothing in Phases 2–3 connects to any of these. */
const FAKE_CONFIG: Config = Object.freeze({
  POSTGRES_URL: "postgres://strata:strata@localhost:5432/strata",
  REDIS_URL: "redis://localhost:6379",
  OLLAMA_URL: "http://localhost:11434",
  EMBEDDING_MODEL: "nomic-embed-text",
  INSTRUCT_MODEL: "qwen2.5:3b-instruct",
  OLLAMA_TIMEOUT_MS: 60_000,
  COMPACTION_ENABLED: false,
});

export function createFakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const log = options.log ?? createSilentLogger();
  const background = createTrackingBackgroundRunner(log);
  return {
    store: createFakeStore(options.store),
    cache: createFakeCache(options.cache),
    ollama: createFakeOllama(options.ollama),
    config: Object.freeze({ ...FAKE_CONFIG, ...definedOnly(options.config) }),
    log,
    background,
  };
}

export function createTrackingBackgroundRunner(log?: Logger): TrackingBackgroundRunner {
  const pending: Promise<void>[] = [];
  const labels: string[] = [];
  const failures: { label: string; error: unknown }[] = [];

  const run = (label: string, work: () => Promise<void>): void => {
    labels.push(label);
    pending.push(
      Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          failures.push({ label, error });
          log?.warn({ label, error: describeUnknown(error) }, "background task failed");
        }),
    );
  };

  // Object.assign, not a type assertion plus defineProperties: the properties end up
  // enumerable, so toMatchObject and snapshots can actually see them.
  return Object.assign(run, {
    labels,
    failures,
    settled: async (): Promise<void> => {
      // A settled task may itself have started another, so drain until stable rather
      // than awaiting one snapshot.
      let seen = 0;
      while (pending.length > seen) {
        seen = pending.length;
        await Promise.all(pending);
      }
    },
  });
}

/**
 * `Partial<Config>` permits an explicit `undefined`, which would spread over a
 * required field and leave a `Config` whose typed-as-number property is undefined —
 * a lying type at a boundary under `exactOptionalPropertyTypes`.
 */
function definedOnly(overrides: Partial<Config> | undefined): Partial<Config> {
  if (overrides === undefined) {
    return {};
  }
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
}
