import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { describeUnknown, isStrataError } from "../errors.js";
import type { Logger } from "../logger.js";

/**
 * What a tool produces: the typed value for `structuredContent`, plus the text an
 * agent reads. Both are required — an agent that only reads `content` must still
 * get a useful answer, and a client that reads `structuredContent` must not have to
 * parse prose.
 */
export interface ToolPayload<T> {
  readonly structured: T;
  readonly text: string;
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
      { tool: name, outcome: "ok", durationMs: elapsed(startedAt) },
      "tool call completed",
    );
    return {
      content: [{ type: "text", text: payload.text }],
      structuredContent: payload.structured,
    };
  } catch (error: unknown) {
    const code = isStrataError(error) ? error.code : "UNEXPECTED";
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
      // The code travels with the message: it is the one piece of a failure an
      // agent can act on, and it is otherwise invisible over the wire.
      content: [{ type: "text", text: `${name} failed [${code}]: ${describeUnknown(error)}` }],
      isError: true,
    };
  }
}

/** Whole milliseconds. Sub-millisecond precision in a log line is noise. */
function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
