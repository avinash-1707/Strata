import type * as z from "zod";

import { StrataError } from "../errors.js";

/**
 * The HTTP counterpart to what the MCP SDK does for free. MCP validates arguments
 * before a handler runs; a route has to ask. Both use the same schema from
 * `src/contracts`, so the two surfaces cannot enforce different rules.
 *
 * Zod issues are surfaced in `details` rather than in the message, since the message
 * crosses the wire and issue text can quote the offending value.
 */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new StrataError("INVALID_INPUT", summarize(result.error), {
      details: { issues: result.error.issues.map((issue) => issue.path.join(".")) },
      publicMessage: summarize(result.error),
    });
  }
  return result.data;
}

/**
 * Takes a reader rather than a body: a malformed payload throws inside `req.json()`,
 * and letting that reach the error boundary as an unknown 500 would report a caller's
 * broken JSON as a server fault.
 */
export async function parseJsonBody<S extends z.ZodType>(
  schema: S,
  read: () => Promise<unknown>,
): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await read();
  } catch (cause: unknown) {
    throw new StrataError("INVALID_INPUT", "request body is not valid JSON", {
      cause,
      publicMessage: "request body is not valid JSON",
    });
  }
  return parseBody(schema, body);
}

/** Field paths and codes only — never the rejected value. */
function summarize(error: z.ZodError): string {
  const fields = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<body>";
    return `${path} (${issue.code})`;
  });
  return `invalid request: ${fields.join(", ")}`;
}

/**
 * Query strings are all strings, so numeric and boolean fields need coercing before a
 * schema built for JSON bodies will accept them. Only keys the schema knows about are
 * coerced; anything else passes through and is rejected by the schema as normal.
 */
export function parseQuery<S extends z.ZodType>(
  schema: S,
  query: Record<string, string | undefined>,
  numeric: readonly string[] = [],
  boolean: readonly string[] = [],
): z.infer<S> {
  const coerced: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (numeric.includes(key)) {
      const asNumber = Number(value);
      // NaN would surface as "expected number, received nan"; passing the raw string
      // through gives the caller a clearer message about the field.
      coerced[key] = Number.isNaN(asNumber) ? value : asNumber;
    } else if (boolean.includes(key)) {
      coerced[key] = value === "true" ? true : value === "false" ? false : value;
    } else {
      coerced[key] = value;
    }
  }

  return parseBody(schema, coerced);
}
