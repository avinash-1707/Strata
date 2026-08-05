import type { Hono } from "hono";

import { forgetInputSchema, restoreInputSchema } from "../../contracts/forget.js";
import { rememberInputSchema } from "../../contracts/remember.js";
import { searchByTagInputSchema } from "../../contracts/searchByTag.js";
import type { ToolDeps } from "../../deps.js";
import { forget, restore } from "../../tools/forget.js";
import { remember } from "../../tools/remember.js";
import { searchByTag } from "../../tools/searchByTag.js";
import { API_PREFIX } from "../app.js";
import { parseBody, parseJsonBody } from "../validate.js";

export function registerMemoryRoutes(app: Hono, deps: ToolDeps): void {
  app.post(`${API_PREFIX}/memories`, async (context) => {
    const input = await parseJsonBody(rememberInputSchema, () => context.req.json());
    const stored = await remember(input, deps);

    // 200, not 201: DD-020 makes this idempotent, and the response is identical
    // whether the memory was created or already existed — so a 201 would be a lie
    // on every duplicate.
    return context.json(stored, 200);
  });

  app.get(`${API_PREFIX}/memories`, async (context) => {
    const input = parseBody(searchByTagInputSchema, readTagQuery(context.req));
    const found = await searchByTag(input, deps);
    return context.json(found, 200);
  });

  /* DD-039: single id only. There is deliberately no bulk-delete route — a runaway
     script has to work one request at a time. The hard purge is never exposed here. */
  app.delete(`${API_PREFIX}/memories/:id`, async (context) => {
    const input = parseBody(forgetInputSchema, { id: context.req.param("id") });
    const result = await forget(input, deps);

    // 200 with `{deleted: false}` rather than a 404: the contract distinguishes
    // "no such live memory" from a successful delete in the body (DD-018), and both
    // surfaces must answer the same question the same way.
    return context.json(result, 200);
  });

  app.post(`${API_PREFIX}/memories/:id/restore`, async (context) => {
    const input = parseBody(restoreInputSchema, { id: context.req.param("id") });
    const result = await restore(input, deps);
    return context.json(result, 200);
  });
}

/**
 * `tags` is repeatable *and* comma-separated, because a query string has no native
 * array and callers reasonably expect both. `req.query()` keeps only the last value
 * of a repeated key, which would silently drop every tag but one.
 */
function readTagQuery(request: {
  queries: (key: string) => string[] | undefined;
  query: (key: string) => string | undefined;
}): Record<string, unknown> {
  const tags = (request.queries("tags") ?? []).flatMap((value) => value.split(","));
  const limit = request.query("limit");

  return {
    tags: tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    ...(request.query("match") === undefined ? {} : { match: request.query("match") }),
    ...(limit === undefined || limit === "" ? {} : { limit: coerceNumber(limit) }),
  };
}

/**
 * A non-numeric value passes through as the original string so the schema reports the
 * field, rather than reporting "expected number, received nan".
 */
function coerceNumber(value: string): string | number {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
