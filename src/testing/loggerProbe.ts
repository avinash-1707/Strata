/**
 * Run as a child process by `src/logger.test.ts` to prove DD-026 against real
 * file descriptors. In-process spying on pino cannot prove this: pino writes
 * through a `SonicBoom` destination that bypasses `process.stdout`, so only a
 * separate process with genuinely separate fds gives an honest answer.
 */
import { createLogger } from "../logger.js";

const log = createLogger("debug");

log.info({ MCP_AUTH_TOKEN: "super-secret-token-value", tool: "probe" }, "probe-info");
log.debug({ nested: { POSTGRES_URL: "postgres://user:pw@host/db" } }, "probe-debug");
log.error({}, "probe-error");
