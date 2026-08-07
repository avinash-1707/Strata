import { describeUnknown } from "./errors.js";
import type { Logger } from "./logger.js";

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
