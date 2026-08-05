import { createRedisCache } from "./cache/redis.js";
import type { Cache } from "./cache/types.js";
import { REPAIR_INTERVAL_MS } from "./config/budgets.js";
import { loadConfig } from "./config/env.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/types.js";
import type { ToolDeps } from "./deps.js";
import { createBackgroundRunner } from "./deps.js";
import { describeUnknown } from "./errors.js";
import { repairPass } from "./jobs/repair.js";
import { createLogger, isLogLevel } from "./logger.js";
import { serveStdio } from "./mcp/stdio.js";
import { createOllamaClient } from "./ollama/client.js";
import { createPgStore } from "./store/pg/index.js";

/** A hung close() must not wedge shutdown: past this, exit anyway. */
const SHUTDOWN_FLOOR_MS = 5_000;

const levelCandidate = process.env["STRATA_LOG_LEVEL"];
const log = createLogger(isLogLevel(levelCandidate) ? levelCandidate : "info");

// Node kills the process on either of these with nothing structured on stderr,
// which an MCP client sees only as the pipe closing. Log first, then die loud.
process.on("uncaughtException", (error) => {
  log.error({ error: describeUnknown(error) }, "uncaught exception; exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error({ error: describeUnknown(reason) }, "unhandled rejection; exiting");
  process.exit(1);
});

let db: Db | undefined;
let cache: Cache | undefined;

/** Failure-isolated: one close() rejecting must not skip the others (both are
 *  idempotent, so the boot-failure path and onShutdown may each call this). */
async function releaseResources(): Promise<void> {
  const results = await Promise.allSettled([
    cache === undefined ? Promise.resolve() : cache.close(),
    db === undefined ? Promise.resolve() : db.close(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn({ error: describeUnknown(result.reason) }, "resource close failed");
    }
  }
}

try {
  // Throws CONFIG_INVALID on a bad environment: refusing to boot beats starting
  // and failing on the first tool call, where the failure reaches the agent as a
  // confusing tool error.
  const config = loadConfig();

  db = createDb(config, log);
  // Boot-time migrations own the schema — the pgvector image only runs init
  // scripts on an empty volume, so this is the only reliable owner (DD-013).
  const applied = await migrate(db);
  log.info({ applied: [...applied] }, "database schema is current");

  cache = createRedisCache(config, log);
  const deps: ToolDeps = {
    store: createPgStore(db),
    cache,
    ollama: createOllamaClient(config),
    config,
    log,
    background: createBackgroundRunner(log),
  };

  // DD-005 stage 3. One pass at boot drains whatever a crash left behind; the
  // interval keeps draining what stage 2 degrades from here on.
  let repairing = false;
  const runRepair = (): void => {
    if (repairing) {
      // A slow pass must not stack a second one behind it: repair calls a
      // CPU-bound model, and overlapping passes would retry the same rows.
      return;
    }
    repairing = true;
    try {
      deps.background("repairPass", async () => {
        try {
          const report = await repairPass(deps);
          if (report.examined > 0) {
            log.info({ ...report }, "repair pass finished");
          }
        } finally {
          repairing = false;
        }
      });
    } catch (error) {
      // If scheduling itself throws, a stuck latch would silently end repair for
      // the life of the process.
      repairing = false;
      log.warn({ error: describeUnknown(error) }, "could not schedule a repair pass");
    }
  };
  runRepair();
  const repairTimer = setInterval(runRepair, REPAIR_INTERVAL_MS);
  // The transport decides the process lifetime, never the repair schedule.
  repairTimer.unref();

  await serveStdio(deps, {
    onShutdown: async () => {
      // unref'd: only a floor under a hung close, never a reason to stay alive.
      setTimeout(() => {
        log.error({}, "shutdown exceeded its floor; exiting");
        process.exit(1);
      }, SHUTDOWN_FLOOR_MS).unref();

      clearInterval(repairTimer);
      await releaseResources();
    },
  });
} catch (error) {
  // Boot failures are loud and structured: stderr, never stdout (DD-026).
  log.error({ error: describeUnknown(error) }, "strata failed to start");
  await releaseResources();
  process.exitCode = 1;
}
