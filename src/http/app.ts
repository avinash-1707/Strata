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

export interface HttpAppOptions {
  /** Skips auth. Only for tests that are not exercising auth itself. */
  readonly allowUnauthenticated?: boolean;
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
  const app = new Hono();

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
    app.use(`${API_PREFIX}/*`, bearerAuth(token));
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
