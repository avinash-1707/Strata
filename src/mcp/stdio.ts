import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describeUnknown } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ToolDeps } from "./deps.js";
import { createStrataServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * Serves the MCP server over stdio and resolves when the client disconnects.
 *
 * DD-026: this is a *local* transport, used on the Mac as a protocol test. The
 * real deployment is cross-host and its transport is decided in Phase 12. Nothing
 * here may assume the client and server share a machine.
 */
export async function serveStdio(deps: ToolDeps): Promise<void> {
  const server = createStrataServer(deps);
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });

  await server.connect(transport);
  // stderr, not stdout: the first byte on stdout must be a protocol frame, or the
  // client fails to parse the stream and reports it as its own bug.
  deps.log.info({ name: SERVER_NAME, version: SERVER_VERSION }, "listening on stdio");

  installShutdownHandlers(deps.log, async () => {
    await server.close();
  });

  await closed;
  deps.log.info({}, "client disconnected");
}

/**
 * SIGINT/SIGTERM arrive when the client kills the subprocess. Closing the server
 * explicitly lets pooled connections drain instead of being severed — harmless
 * today with fakes, load-bearing once a pg Pool is behind them.
 */
function installShutdownHandlers(log: Logger, shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      log.info({ signal }, "shutting down");
      void shutdown().catch((error: unknown) => {
        log.error({ signal, error: describeUnknown(error) }, "shutdown failed");
      });
    });
  }
}
