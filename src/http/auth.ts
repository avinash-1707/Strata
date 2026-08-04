import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { StrataError } from "../errors.js";

/**
 * A single bearer token, deliberately. Multi-user is a hard non-goal, so there are no
 * accounts, no sessions, and no per-caller scopes to get wrong — a token either is the
 * configured one or it is not.
 */
export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(token, "utf8");

  return async (context, next) => {
    const header = context.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (!matches(expected, presented)) {
      // No detail about *why*: distinguishing "missing" from "wrong" tells an attacker
      // which half to work on.
      throw new StrataError("UNAUTHORIZED", "unauthorized", {
        publicMessage: "unauthorized",
        details: { reason: header === "" ? "missing" : "mismatch" },
      });
    }

    await next();
  };
}

/**
 * `timingSafeEqual` throws on a length mismatch, and the length check itself leaks
 * length — unavoidable, and harmless for a fixed-length configured secret. Comparing
 * with `===` would leak the matching prefix instead, which is worse.
 */
function matches(expected: Buffer, presented: string): boolean {
  const candidate = Buffer.from(presented, "utf8");
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}
