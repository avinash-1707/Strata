import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";

import { CONNECTION_DRAIN_MS } from "../config/budgets.js";
import { describeUnknown } from "../errors.js";
import type { Logger } from "../logger.js";
import { installShutdownHandlers, once, runTeardown, withShutdownFloor } from "../shutdown.js";

export interface ServeHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly log: Logger;

  /** Released after the listener has closed and before this resolves. */
  readonly onShutdown?: () => Promise<void>;
}

/**
 * Serves the app over HTTP and resolves only once the listener has closed and
 * teardown has finished — so `await serveHttp(...)` is the process's lifetime.
 *
 * Unlike stdio, this is a long-lived daemon: it outlives any one client session, which
 * is what makes a single REST listener, a single MCP endpoint, and one scheduled repair
 * pass coherent in the same process (DD-036, DD-053).
 */
export async function serveHttp(app: Hono, options: ServeHttpOptions): Promise<void> {
  const { log } = options;

  let failBoot: (error: Error) => void = () => undefined;

  const server = serve(
    { fetch: app.fetch, hostname: options.host, port: options.port },
    (info) => {
      log.info({ host: info.address, port: info.port }, "listening on http");
      /* Swapped once the bind succeeded: from here `reject` is a no-op on a settled
         promise, so leaving it attached would make a genuine server error vanish. */
      server.off("error", failBoot);
      server.on("error", (error: Error) => {
        log.error({ error: describeUnknown(error) }, "http server error");
      });
    },
  );

  /* Attached in the same tick as serve(): Node emits listen failures no earlier than
     the next tick, and an 'error' with no listener is thrown rather than reported. A
     bind failure (EADDRINUSE, an unroutable host) must fail the boot loudly rather
     than leave a process that answers nothing. */
  const closed = new Promise<void>((resolve, reject) => {
    failBoot = reject;
    server.on("error", failBoot);
    server.on("close", resolve);
  });

  /* The floor wraps both steps, not just the caller's. `close()` not firing its
     callback would otherwise hang the process with no timer left to exit it. */
  const teardown = once(() =>
    withShutdownFloor(log, async () => {
      await stopListening(server, log);
      if (options.onShutdown !== undefined) {
        await options.onShutdown();
      }
    }),
  );

  installShutdownHandlers(log, teardown);

  await closed;
  // `closed` resolves inside teardown, so this awaits the rest of that same run.
  await runTeardown(log, teardown);
}

async function stopListening(server: ServerType, log: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    const forced = setTimeout(() => {
      // Narrowed rather than cast: ServerType includes HTTP/2 servers, which have no
      // such method. Strata serves plain HTTP, so it is present at runtime.
      if ("closeAllConnections" in server) {
        log.warn({ drainMs: CONNECTION_DRAIN_MS }, "forcing open connections closed");
        server.closeAllConnections();
      } else {
        // Nothing else bounds the drain, so a silent no-op here is a hang.
        log.error({}, "this server cannot force connections closed; shutdown may hang");
      }
    }, CONNECTION_DRAIN_MS);
    forced.unref();

    // The callback's error argument is ignored deliberately: it only reports that the
    // server was already closed, and this path is reached from an idempotent teardown.
    server.close(() => {
      clearTimeout(forced);
      resolve();
    });
  });
}
