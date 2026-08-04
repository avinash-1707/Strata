import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { describeUnknown, isStrataError, publicMessageOf } from "../errors.js";
import type { LogContext, Logger } from "../logger.js";

/**
 * What a tool produces: the typed value for `structuredContent`, plus the text an
 * agent reads. Both are required — an agent that only reads `content` must still
 * get a useful answer, and a client that reads `structuredContent` must not have to
 * parse prose.
 */
export interface ToolPayload<T> {
  readonly structured: T;
  readonly text: string;
  /**
   * Merged into this call's single log line — result count, cache hit/miss, and
   * `remember`'s resulting status. It travels with the payload so that a tool never
   * has to emit a second line, which would make a log aggregator see two records
   * per invocation.
   */
  readonly log?: LogContext;
}

/**
 * The single wrapper every tool handler goes through. It exists so that the
 * per-invocation log line (tool, duration, outcome) and the
 * error-to-`isError` mapping have exactly one implementation, rather than being
 * re-derived — slightly differently — in each of the four tools.
 *
 * A tool-level failure returns `isError: true` with a useful message rather than
 * throwing, because a thrown error reaches the agent as a protocol fault it cannot
 * act on.
 */
export async function runTool<T extends Record<string, unknown>>(
  name: string,
  log: Logger,
  work: () => Promise<ToolPayload<T>>,
): Promise<CallToolResult> {
  const startedAt = performance.now();

  try {
    const payload = await work();
    log.info(
      { ...payload.log, tool: name, outcome: "ok", durationMs: elapsed(startedAt) },
      "tool call completed",
    );
    return {
      content: [{ type: "text", text: payload.text }],
      structuredContent: payload.structured,
    };
  } catch (error: unknown) {
    const code = isStrataError(error) ? error.code : "UNEXPECTED";

    // The full cause goes to stderr only. It is the diagnosis, and it is also the
    // one place a Postgres error's statement text, parameter values, or a DSN's
    // credentials can appear.
    log.error(
      {
        tool: name,
        outcome: "error",
        code,
        durationMs: elapsed(startedAt),
        error: describeUnknown(error),
      },
      "tool call failed",
    );

    return {
      content: [{ type: "text", text: `${name} failed [${code}]: ${publicMessageOf(error)}` }],
      isError: true,
    };
  }
}

/** Whole milliseconds. Sub-millisecond precision in a log line is noise. */
function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
