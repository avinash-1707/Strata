import { createRedisCache } from "./cache/redis.js";
import { REPAIR_INTERVAL_MS } from "./config/budgets.js";
import { loadConfig } from "./config/env.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import type { ToolDeps } from "./deps.js";
import { createBackgroundRunner } from "./deps.js";
import { describeUnknown } from "./errors.js";
import { repairPass } from "./jobs/repair.js";
import { createLogger, isLogLevel } from "./logger.js";
import { serveStdio } from "./mcp/stdio.js";
import { createOllamaClient } from "./ollama/client.js";
import { createPgStore } from "./store/pg/index.js";

const levelCandidate = process.env["STRATA_LOG_LEVEL"];
const log = createLogger(isLogLevel(levelCandidate) ? levelCandidate : "info");

try {
  // Throws CONFIG_INVALID on a bad environment: refusing to boot beats starting
  // and failing on the first tool call, where the failure reaches the agent as a
  // confusing tool error.
  const config = loadConfig();

  const db = createDb(config, log);
  // Boot-time migrations own the schema — the pgvector image only runs init
  // scripts on an empty volume, so this is the only reliable owner (DD-013).
  const applied = await migrate(db);
  log.info({ applied: [...applied] }, "database schema is current");

  const deps: ToolDeps = {
    store: createPgStore(db),
    cache: createRedisCache(config, log),
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
  };
  runRepair();
  const repairTimer = setInterval(runRepair, REPAIR_INTERVAL_MS);
  // The transport decides the process lifetime, never the repair schedule.
  repairTimer.unref();

  await serveStdio(deps, {
    onShutdown: async () => {
      clearInterval(repairTimer);
      await deps.cache.close();
      await db.close();
    },
  });
} catch (error) {
  // Boot failures are loud and structured: stderr, never stdout (DD-026).
  log.error({ error: describeUnknown(error) }, "strata failed to start");
  process.exitCode = 1;
}
