import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ToolDeps } from "../deps.js";
import { installShutdownHandlers, once, runTeardown, withShutdownFloor } from "../shutdown.js";
import type { ToolRegistrar } from "./server.js";
import { createStrataServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export interface ServeStdioOptions {
  /** Test-only tools. Nothing in `src` passes this. */
  readonly extraTools?: readonly ToolRegistrar[];

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
 * A *local* transport, selected by `STRATA_TRANSPORT=stdio`. The deployment transport
 * is the HTTP daemon (DD-036, DD-053): stdio is spawned per client session, so it can
 * neither share a process with a listener nor host a single repair schedule.
 */
export async function serveStdio(deps: ToolDeps, options: ServeStdioOptions = {}): Promise<void> {
  const server = createStrataServer(deps, options.extraTools ?? []);
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });

  await server.connect(transport);
  // stderr, not stdout: the first byte on stdout must be a protocol frame, or the
  // client fails to parse the stream and reports it as its own bug.
  deps.log.info({ name: SERVER_NAME, version: SERVER_VERSION }, "listening on stdio");

  // The floor covers `server.close()` as well as the caller's release, because both
  // can hang and neither has another bound.
  const teardown = once(() =>
    withShutdownFloor(deps.log, async () => {
      await server.close();
      if (options.onShutdown !== undefined) {
        await options.onShutdown();
      }
    }),
  );

  /* StdioServerTransport subscribes to stdin's 'data' and 'error' only — never 'end'.
     So a client that closes the stream instead of signalling leaves the transport
     open, `closed` unresolved, and the process exiting on an unsettled top-level
     await (status 13) having run no teardown at all. */
  process.stdin.once("end", () => {
    deps.log.info({}, "stdin closed");
    void runTeardown(deps.log, teardown);
  });

  /* A timer to hold the event loop open across teardown was tried and removed: with
     it gone, all three teardown paths still complete and exit 0, so it was doing no
     work. */
  installShutdownHandlers(deps.log, teardown);

  await closed;
  await runTeardown(deps.log, teardown);
  deps.log.info({}, "client disconnected");
}
