import { SHUTDOWN_FLOOR_MS } from "./config/budgets.js";
import { describeUnknown } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Runs teardown with a floor under it: past `SHUTDOWN_FLOOR_MS`, exit anyway.
 *
 * A wrapper rather than two lines at each call site, because *what it wraps* is the
 * whole point. The floor has to cover the step most likely to hang — closing the
 * listener, and `pool.end()`, which cannot finish while the repair pass holds a
 * pooled connection through a CPU-bound model call. Armed downstream of either, it
 * watches the part that was never the risk.
 *
 * The timer is cleared on the way out. `unref()` alone is not enough: it stops the
 * timer keeping the loop alive, but a still-running process — a test host, a stdio
 * session that tore down one server and kept going — would still take the exit.
 */
export async function withShutdownFloor(log: Logger, work: () => Promise<void>): Promise<void> {
  const floor = setTimeout(() => {
    log.error({ floorMs: SHUTDOWN_FLOOR_MS }, "shutdown exceeded its floor; exiting");
    process.exit(1);
  }, SHUTDOWN_FLOOR_MS);
  floor.unref();

  try {
    await work();
  } finally {
    clearTimeout(floor);
  }
}

/**
 * Teardown is reachable from more than one path — a signal, and the transport
 * noticing the client is gone — and must not run twice: it closes a pg Pool and a
 * Redis socket, and the second close of either is at best a warning.
 */
export function once(work: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => {
    started ??= work();
    return started;
  };
}

/**
 * SIGINT/SIGTERM arrive when an MCP client kills the stdio subprocess, and when
 * Docker stops the daemon container. Both must release resources rather than being
 * killed mid-write.
 */
export function installShutdownHandlers(log: Logger, teardown: () => Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info({ signal }, "shutting down");
      void runTeardown(log, teardown);
    });
  }
}

export async function runTeardown(log: Logger, teardown: () => Promise<void>): Promise<void> {
  try {
    await teardown();
  } catch (error: unknown) {
    // Nothing left to return an error to; the caller is already gone.
    log.error({ error: describeUnknown(error) }, "shutdown failed");
  }
}
