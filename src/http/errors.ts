import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { StrataErrorCode } from "../errors.js";
import { isStrataError, publicMessageOf } from "../errors.js";

/**
 * Every `StrataErrorCode` mapped explicitly. A `Record` rather than a `switch` with a
 * default, so adding a code to the union fails to compile until its status is chosen
 * — the alternative is a new failure mode silently becoming a 500.
 */
const STATUS_BY_CODE: Record<StrataErrorCode, ContentfulStatusCode> = {
  // A misconfigured server is our fault, not the caller's.
  CONFIG_INVALID: 500,
  // Postgres is load-bearing: unreachable means try again later, not "bad request".
  DB_QUERY_FAILED: 503,
  CACHE_UNAVAILABLE: 503,
  OLLAMA_UNAVAILABLE: 503,
  // Reachable but unusable output is an upstream fault, which is what 502 means.
  OLLAMA_BAD_RESPONSE: 502,
  // A model/schema mismatch is a deployment defect the caller cannot fix.
  EMBEDDING_DIM_MISMATCH: 500,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  INVALID_INPUT: 400,
};

/** A 401 without this header is malformed per RFC 9110. */
export const UNAUTHORIZED_HEADERS = { "www-authenticate": 'Bearer realm="strata"' } as const;

export interface ErrorBody {
  readonly error: {
    readonly code: StrataErrorCode | "UNEXPECTED";
    readonly message: string;
  };
}

export function statusForError(error: unknown): ContentfulStatusCode {
  return isStrataError(error) ? STATUS_BY_CODE[error.code] : 500;
}

/**
 * A REST response body is read by browsers, proxy logs, and scripts — a wider audience
 * than an MCP transcript. So it carries `publicMessageOf`, never a wrapped cause,
 * whose text holds statements, parameter values, and DSN credentials.
 */
export function errorBody(error: unknown): ErrorBody {
  return {
    error: {
      code: isStrataError(error) ? error.code : "UNEXPECTED",
      message: publicMessageOf(error),
    },
  };
}
