/**
 * A runnable Strata server backed entirely by fakes, for Phase 2's protocol test:
 * a real MCP client connects over stdio, lists tools, and calls one. No Postgres,
 * no Redis, no model.
 *
 * It lives under `src/testing` — excluded from the build — because it must never
 * be mistaken for the real entrypoint. Phase 4 adds `src/main.ts`, which wires the
 * same `serveStdio` to real clients.
 *
 * Run with: pnpm dev:fake
 */
import { isLogLevel } from "../logger.js";
import { createLogger } from "../logger.js";
import { createBackgroundRunner } from "../mcp/deps.js";
import { serveStdio } from "../mcp/stdio.js";
import { createFakeDeps } from "./fakeDeps.js";

const level = process.env["STRATA_LOG_LEVEL"];
const log = createLogger(isLogLevel(level) ? level : "info");

const deps = {
  ...createFakeDeps({ log }),
  // The real runner, not the test-tracking one: this process serves a live client,
  // so background failures should be logged rather than collected.
  background: createBackgroundRunner(log),
};

await serveStdio(deps, {
  onShutdown: async () => {
    // Phase 4's main.ts closes a pg Pool and a Redis socket here. With fakes there is
    // nothing to release, so the log line is the only observable — which is exactly
    // what the stdio test asserts, to prove the seam is actually reached.
    await deps.cache.close();
    log.info({}, "released resources");
  },
});
