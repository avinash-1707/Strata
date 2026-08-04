/**
 * OLLAMA_UNAVAILABLE and OLLAMA_BAD_RESPONSE stay separate because they are
 * different problems with different fixes: unreachable service vs. unusable
 * answer. Codes exist only where a caller would plausibly branch on them.
 */
export type StrataErrorCode =
  | "CONFIG_INVALID"
  | "DB_QUERY_FAILED"
  | "CACHE_UNAVAILABLE"
  | "OLLAMA_UNAVAILABLE"
  | "OLLAMA_BAD_RESPONSE"
  | "EMBEDDING_DIM_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_INPUT";

export interface StrataErrorOptions {
  readonly cause?: unknown;
  /** Log context. Must never contain secrets or memory content. */
  readonly details?: Record<string, unknown>;
  /**
   * The part of `message` safe to send to an agent. Set whenever `message` embeds
   * text from a driver or a model, because that text carries statements, parameter
   * values, and connection credentials.
   */
  readonly publicMessage?: string;
}

export class StrataError extends Error {
  override readonly name = "StrataError";
  readonly code: StrataErrorCode;
  // `| undefined` rather than optional: under exactOptionalPropertyTypes an
  // optional property rejects an explicitly-undefined value, which is what
  // `options?.details` produces.
  readonly details: Record<string, unknown> | undefined;
  readonly publicMessage: string | undefined;

  constructor(
    code: StrataErrorCode,
    message: string,
    options?: StrataErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options?.details;
    this.publicMessage = options?.publicMessage;
  }
}

/**
 * The text that may cross the MCP boundary. `message` is for stderr: it can embed a
 * cause, and a tool result is read by a model and kept in a client transcript.
 */
export function publicMessageOf(error: unknown): string {
  if (isStrataError(error)) {
    return error.publicMessage ?? error.message;
  }
  return "an unexpected internal error occurred";
}

export function isStrataError(value: unknown): value is StrataError {
  return value instanceof StrataError;
}

/**
 * Renders any caught value as loggable text. Caught values are `unknown` and a
 * thrown non-Error is entirely possible, so this must never throw and never
 * return "[object Object]".
 */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  // Handled before stringify because these are exactly the top-level inputs for
  // which JSON.stringify returns undefined despite being typed as string.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Circular reference or throwing getter.
    return Object.prototype.toString.call(value);
  }
}

/**
 * An existing StrataError passes through unchanged: the innermost layer knows the
 * most specific code, and re-wrapping would bury it.
 */
export function wrapError(
  code: StrataErrorCode,
  message: string,
  cause: unknown,
  details?: Record<string, unknown>,
): StrataError {
  if (isStrataError(cause)) {
    return cause;
  }
  return new StrataError(code, `${message}: ${describeUnknown(cause)}`, {
    cause,
    // Only the authored prefix is public: the interpolated cause is a driver's
    // text, which carries statements, parameter values, and DSN credentials.
    publicMessage: message,
    ...(details === undefined ? {} : { details }),
  });
}
