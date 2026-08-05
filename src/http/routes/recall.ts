import type { Hono } from "hono";

import { recallInputSchema } from "../../contracts/recall.js";
import type { ToolDeps } from "../../deps.js";
import { recall } from "../../tools/recall.js";
import { API_PREFIX } from "../app.js";
import { parseJsonBody } from "../validate.js";

/**
 * POST despite being a read: the query can run to 2,000 characters and carries
 * `session_id`, which has no business sitting in a proxy access log.
 */
export function registerRecallRoutes(app: Hono, deps: ToolDeps): void {
  app.post(`${API_PREFIX}/recall`, async (context) => {
    const input = await parseJsonBody(recallInputSchema, () => context.req.json());
    const found = await recall(input, deps);
    return context.json(found, 200);
  });
}
