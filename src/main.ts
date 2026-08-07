import { createRedisCache } from "./cache/redis.js";
import type { Cache } from "./cache/types.js";
import { REPAIR_BATCH_SIZE, REPAIR_INTERVAL_MS } from "./config/budgets.js";
import { loadConfig } from "./config/env.js";
import { createDb } from "./db/client.js";
import { withRepairLock } from "./db/locks.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/types.js";
import type { ToolDeps } from "./deps.js";
import { createBackgroundRunner } from "./deps.js";
import { describeUnknown } from "./errors.js";
import { createHttpApp } from "./http/app.js";
import { serveHttp } from "./http/serve.js";
import { repairPass } from "./jobs/repair.js";
import { createLogger, isLogLevel } from "./logger.js";
import { createMcpHttpHandler } from "./mcp/http.js";
import { serveStdio } from "./mcp/stdio.js";
import { withShutdownFloor } from "./shutdown.js";
import { createOllamaClient } from "./ollama/client.js";
import { createPgStore } from "./store/pg/index.js";

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

/**
 * Cancels model calls the process no longer wants an answer to. Declared out here
 * because the boot-failure path needs it too: `repairPass` fires before the transport
 * binds, so an EADDRINUSE can land with a pass already holding a pooled connection
 * through a 60 s generation — and `pool.end()` waits behind it.
 */
const stopping = new AbortController();

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

  // Local binding as well as the module-level one: the shutdown path needs the
  // latter, and a closure cannot narrow a `let` that another path may reassign.
  const database = createDb(config, log);
  db = database;
  // Boot-time migrations own the schema — the pgvector image only runs init
  // scripts on an empty volume, so this is the only reliable owner (DD-013).
  const applied = await migrate(database);
  log.info({ applied: [...applied] }, "database schema is current");

  cache = createRedisCache(config, log);
  const deps: ToolDeps = {
    store: createPgStore(database),
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
    if (stopping.signal.aborted) {
      // Taking the advisory lock during teardown is the thing this exists to avoid.
      return;
    }
    if (repairing) {
      // A slow pass must not stack a second one behind it: repair calls a
      // CPU-bound model, and overlapping passes would retry the same rows.
      return;
    }
    repairing = true;
    try {
      deps.background("repairPass", async () => {
        try {
          /* The latch above only guards *this* process. Under the HTTP daemon there is
             normally only one, but a stdio session or a second deployment against the
             same database would each run their own pass over one backlog, double-
             counting enhancement_attempts against a cap of 5 (DD-045). */
          const report = await withRepairLock(database, log, () =>
            repairPass(deps, REPAIR_BATCH_SIZE, stopping.signal),
          );
          if (report === undefined) {
            log.debug({}, "another process is repairing; skipping this pass");
          } else if (report.examined > 0) {
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

  // The transport arms the shutdown floor around this: it owns the other half of
  // teardown, and the floor has to cover both.
  const onShutdown = async (): Promise<void> => {
    // First, before anything that waits: a pass in flight releases its connection and
    // the advisory lock as soon as the cancelled model call unwinds.
    stopping.abort();
    clearInterval(repairTimer);
    await releaseResources();
  };

  if (config.STRATA_TRANSPORT === "stdio") {
    await serveStdio(deps, { onShutdown });
  } else {
    /* One listener, both surfaces. The MCP handler is passed in rather than imported
       by the app: `src/http` may not import `src/mcp` (DD-032), and this file is the
       composition root that is allowed to name both (DD-036). */
    const app = createHttpApp(deps, { mcp: createMcpHttpHandler(deps) });
    await serveHttp(app, {
      host: config.HTTP_HOST,
      port: config.HTTP_PORT,
      log,
      onShutdown,
    });
  }
} catch (error) {
  // Boot failures are loud and structured: stderr, never stdout (DD-026).
  log.error({ error: describeUnknown(error) }, "strata failed to start");
  stopping.abort();
  /* Under the floor for the same reason the transport's teardown is: the boot pass of
     repairPass has already started by the time a bind can fail, so `pool.end()` waits
     behind a CPU-bound model call — and `up -d --wait` waits on that. */
  await withShutdownFloor(log, releaseResources);
  process.exitCode = 1;
}
