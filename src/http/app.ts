import { Hono } from "hono";

import type { ToolDeps } from "../deps.js";
import { describeUnknown, isStrataError, StrataError } from "../errors.js";
import { bearerAuth } from "./auth.js";
import { errorBody, statusForError, UNAUTHORIZED_HEADERS } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerRecallRoutes } from "./routes/recall.js";

/**
 * Versioned because these routes are public API in the same sense the tool contracts
 * are (DD-018): once a script depends on a shape, changing it is a breaking change.
 */
export const API_PREFIX = "/v1";

/** The ecosystem convention, and what an MCP client's configured URL ends in. */
export const MCP_PATH = "/mcp";

export interface HttpAppOptions {
  /** Skips auth. Only for tests that are not exercising auth itself. */
  readonly allowUnauthenticated?: boolean;

  /**
   * Mounted at `MCP_PATH` when present, so one listener serves both surfaces (DD-036).
   *
   * Injected rather than imported: `src/http` may not import `src/mcp` (DD-032), and
   * a surface that reached into another surface is exactly the rot that seam exists
   * to prevent. The composition root owns the wiring.
   */
  readonly mcp?: (request: Request) => Promise<Response>;
}

/**
 * The REST surface for non-agent consumers — scripts, a dashboard, anything that is
 * not an MCP client. It calls the same `src/tools` functions the MCP surface does and
 * differs only in validation, status codes, and serialization.
 *
 * Returns the app rather than a listening server, so tests drive it with
 * `app.request()` and never bind a port.
 */
export function createHttpApp(deps: ToolDeps, options: HttpAppOptions = {}): Hono {
  /* Hono's default is strict, under which `/mcp/` matches neither the auth middleware
     nor the route — an MCP client configured with a trailing slash would get an
     unauthenticated REST-shaped 404 and no log line naming the cause. `/v1/*` already
     tolerated both forms, so this only closes the MCP path's gap. */
  const app = new Hono({ strict: false });

  /* MCP_AUTH_TOKEN is optional in config because stdio has no HTTP surface to
     authenticate (DD-026). Serving HTTP without it would expose the whole corpus to
     anything on the LAN, so it becomes required here — and it fails at construction,
     not on the first request, so a misconfigured server never starts. */
  if (options.allowUnauthenticated !== true) {
    const token = deps.config.MCP_AUTH_TOKEN;
    if (token === undefined) {
      throw new StrataError(
        "CONFIG_INVALID",
        "MCP_AUTH_TOKEN is required to serve the HTTP API",
      );
    }
    const auth = bearerAuth(token);
    app.use(`${API_PREFIX}/*`, auth);
    // The MCP surface is not a second security domain: an unauthenticated agent must
    // not reach the corpus by speaking JSON-RPC instead of REST.
    app.use(MCP_PATH, auth);
  }

  /* Registered after the auth middleware because Hono runs handlers in registration
     order: mounting this first would serve MCP without a token. */
  const mcp = options.mcp;
  if (mcp !== undefined) {
    // `all`, not `post`: the handler answers non-POST itself with a 405 an MCP client
    // can parse, rather than falling through to this app's REST-shaped 404.
    app.all(MCP_PATH, (context) => mcp(context.req.raw));
  }

  /* Health stays on REST while the MCP tool is gone (DD-043): an operator, a
     dashboard, and a container healthcheck all need it; an agent does not. */
  registerHealthRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerRecallRoutes(app, deps);

  app.notFound((context) =>
    context.json(errorBody(new StrataError("NOT_FOUND", "no such endpoint")), 404),
  );

  /* One error boundary for the whole surface, mirroring what runTool does for MCP: a
     route throws a StrataError and the status mapping happens in exactly one place. */
  app.onError((error, context) => {
    const status = statusForError(error);
    const level = status >= 500 ? "error" : "warn";
    deps.log[level](
      {
        surface: "http",
        method: context.req.method,
        path: context.req.path,
        status,
        code: isStrataError(error) ? error.code : "UNEXPECTED",
        // Full cause to stderr only; the response body carries publicMessageOf.
        error: describeUnknown(error),
      },
      "http request failed",
    );
    return status === 401
      ? context.json(errorBody(error), status, UNAUTHORIZED_HEADERS)
      : context.json(errorBody(error), status);
  });

  return app;
}
