import type { Hono } from "hono";

import { healthInputSchema } from "../../contracts/health.js";
import type { ToolDeps } from "../../deps.js";
import { health } from "../../tools/health.js";
import { API_PREFIX } from "../app.js";
import { parseQuery } from "../validate.js";

/**
 * The shape every route follows: validate with the shared contract schema, call the
 * domain tool, serialize. No logic — that lives in `src/tools`, where the MCP surface
 * reaches it too.
 */
export function registerHealthRoutes(app: Hono, deps: ToolDeps): void {
  app.get(`${API_PREFIX}/health`, async (context) => {
    const input = parseQuery(healthInputSchema, context.req.query());
    const report = await health(input, deps);

    // 200 even when the cache is down: Redis is not load-bearing, so a degraded
    // report is a successful response (DD-005). Only Postgres failing is a 503.
    return context.json(report, 200);
  });
}
