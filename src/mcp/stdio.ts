import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describeUnknown } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ToolDeps } from "./deps.js";
import { createStrataServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export interface ServeStdioOptions {
  /**
   * Released after the client goes away and before this resolves. `ToolDeps` holds
   * no `Db` and nothing else calls `Cache.close()`, so without this seam a pg Pool
   * and a Redis socket would simply be severed on exit. Phase 4's `main.ts` is what
   * populates it.
   */
  readonly onShutdown?: () => Promise<void>;
}

/**
 * Serves the MCP server over stdio and resolves once the client is gone and teardown
 * has finished.
 *
 * DD-026: a *local* transport, used on the Mac as a protocol test. The real
 * deployment is cross-host and its transport is Phase 12's decision.
 */
export async function serveStdio(deps: ToolDeps, options: ServeStdioOptions = {}): Promise<void> {
  const server = createStrataServer(deps);
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });

  await server.connect(transport);
  // stderr, not stdout: the first byte on stdout must be a protocol frame, or the
  // client fails to parse the stream and reports it as its own bug.
  deps.log.info({ name: SERVER_NAME, version: SERVER_VERSION }, "listening on stdio");

  const teardown = once(async () => {
    await server.close();
    if (options.onShutdown !== undefined) {
      await options.onShutdown();
    }
  });

  /* StdioServerTransport subscribes to stdin's 'data' and 'error' only — never 'end'.
     So a client that closes the stream instead of signalling leaves the transport
     open, `closed` unresolved, and the process exiting on an unsettled top-level
     await (status 13) having run no teardown at all. */
  process.stdin.once("end", () => {
    deps.log.info({}, "stdin closed");
    void runTeardown(deps.log, teardown);
  });

  // A signal from the client killing the subprocess runs the same teardown.
  installShutdownHandlers(deps.log, teardown);

  await closed;
  await runTeardown(deps.log, teardown);
  deps.log.info({}, "client disconnected");
}

/**
 * SIGINT/SIGTERM arrive when the client kills the subprocess — this is how Claude
 * Code stops the server.
 *
 * A timer to hold the event loop open across teardown was tried and removed: with it
 * gone, all three teardown paths still complete and exit 0, so it was doing no work.
 * Phase 4 should re-check once a pg Pool is behind `onShutdown`, since that is the
 * case where a slow close could in principle race the loop draining.
 */
function installShutdownHandlers(log: Logger, teardown: () => Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info({ signal }, "shutting down");
      void runTeardown(log, teardown);
    });
  }
}

async function runTeardown(log: Logger, teardown: () => Promise<void>): Promise<void> {
  try {
    await teardown();
  } catch (error: unknown) {
    // Nothing left to return an error to; the client is already gone.
    log.error({ error: describeUnknown(error) }, "shutdown failed");
  }
}

/** Teardown is reachable from two paths and must not run twice. */
function once(work: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => {
    started ??= work();
    return started;
  };
}
