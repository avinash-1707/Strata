import type { Cache } from "./cache/types.js";
import type { Config } from "./config/env.js";
import { describeUnknown } from "./errors.js";
import type { Logger } from "./logger.js";
import type { Ollama } from "./ollama/types.js";
import type { MemoryStore } from "./store/types.js";

/**
 * Everything a tool may touch, passed explicitly (DD-032). Notably absent: a `Db`.
 * Tools compose domain operations and contain no SQL, so the raw pool never
 * reaches this far up.
 */
export interface ToolDeps {
  readonly store: MemoryStore;
  readonly cache: Cache;
  readonly ollama: Ollama;
  readonly config: Config;
  readonly log: Logger;
  readonly background: BackgroundRunner;
}

/**
 * Runs work that must not delay the response — DD-011's usage update on a cache hit
 * above all, which otherwise has no correct spelling: awaiting it makes a hit slower
 * than the miss it replaced, and floating the promise is banned (§7).
 */
export type BackgroundRunner = (label: string, work: () => Promise<void>) => void;

/**
 * Failures are logged at `warn` and go no further: the caller has already been
 * served, so there is nobody left to return an error to.
 */
export function createBackgroundRunner(log: Logger): BackgroundRunner {
  return (label, work) => {
    // `.then(work)` rather than `work().catch(...)`: a synchronous throw inside
    // `work` escapes the latter entirely and would surface in the response path
    // this runner exists to keep clear.
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        log.warn({ label, error: describeUnknown(error) }, "background task failed");
      });
  };
}
