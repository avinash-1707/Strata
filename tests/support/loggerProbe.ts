/**
 * Run as a child process by `src/logger.test.ts` to prove DD-026 against real
 * file descriptors. In-process spying on pino cannot prove this: pino writes
 * through a `SonicBoom` destination that bypasses `process.stdout`, so only a
 * separate process with genuinely separate fds gives an honest answer.
 */
import { createLogger } from "../../src/logger.js";

const log = createLogger("debug");

log.info({ MCP_AUTH_TOKEN: "super-secret-token-value", tool: "probe" }, "probe-info");
log.debug({ nested: { POSTGRES_URL: "postgres://user:pw@host/db" } }, "probe-debug");
log.error(
  {
    // A DSN inside a *message string* is what path-based redaction cannot see: this
    // is the shape a driver error arrives in.
    error: "connect ECONNREFUSED postgres://strata:s3cret@10.0.0.4:5432/strata",
    detail: { inner: ["also redis://:hunter2@cache:6379 in an array"] },
  },
  "probe-error",
);
