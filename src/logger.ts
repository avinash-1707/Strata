import pino from "pino";

/**
 * The logging seam. Kept as a hand-written interface rather than pino's own type
 * so tests and fakes can implement it without depending on pino, and so a
 * replacement never ripples past this file.
 */
export interface Logger {
  debug(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
  child(context: LogContext): Logger;
}

export type LogContext = Readonly<Record<string, unknown>>;

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Keys whose values never appear in a log line at any level. Connection strings
 * are included because they carry credentials in their userinfo component.
 */
const REDACTED_PATHS = [
  "MCP_AUTH_TOKEN",
  "POSTGRES_URL",
  "REDIS_URL",
  "token",
  "*.MCP_AUTH_TOKEN",
  "*.POSTGRES_URL",
  "*.REDIS_URL",
  "*.token",
] as const;

/**
 * Connection strings carry credentials in their userinfo component, and a driver
 * error's `message` embeds the DSN it failed to reach — inside a string value, where
 * pino's path-based `redact` cannot see it.
 */
const DSN_PATTERN = /\b(?:postgres|postgresql|redis|rediss):\/\/\S+/gi;

/** Bounds the walk below. Log context here is shallow by construction. */
const MAX_SCRUB_DEPTH = 6;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.replace(DSN_PATTERN, "[redacted-dsn]");
  }
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = scrubValue(item, depth + 1);
  }
  return out;
}

/**
 * stdout is the MCP protocol channel, so every byte of logging goes to fd 2
 * (DD-026). `pino.destination(2)` is what enforces that; pino's default is fd 1.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  return pino(
    {
      level,
      // `null`, not `undefined`: that is pino's spelling for "no base fields".
      // pid and hostname are noise for a single-process, single-host server.
      base: null,
      redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
      formatters: {
        log: (object) => scrubValue(object, 0) as Record<string, unknown>,
      },
    },
    pino.destination(2),
  );
}

/** Discards everything. For tests that assert behavior rather than output. */
export function createSilentLogger(): Logger {
  const self: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => self,
  };
  return self;
}

function noop(): void {
  // Intentionally empty: the silent logger's whole contract is to do nothing.
}
