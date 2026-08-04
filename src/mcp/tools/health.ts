import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import { describeUnknown } from "../../errors.js";
import type { ToolDeps } from "../deps.js";
import { runTool } from "../invoke.js";

/**
 * Phase 2's trivial tool. It exists to retire protocol risk — schema validation,
 * registration, transport, structured output — and to prove `ToolDeps` injection
 * works end to end, not to serve memory. The four real tools arrive in Phase 3.
 */
const TOOL_NAME = "strata_health";

const inputShape = {
  /** Echoed back verbatim, so a caller can correlate a response with its request. */
  echo: z.string().max(200).optional(),
};

const outputShape = {
  ok: z.boolean(),
  /** Null when Redis is unreachable, since the cache is not load-bearing. */
  corpus_version: z.number().int().nullable(),
  cache: z.enum(["up", "down"]),
  compaction_enabled: z.boolean(),
  echo: z.string().optional(),
};

export function registerHealthTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Strata health",
      description:
        "Report whether the Strata memory server is reachable and which corpus " +
        "version it is serving. Useful for confirming the connection before " +
        "relying on memory tools; not a memory operation itself.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ echo }) =>
      runTool(TOOL_NAME, deps.log, async () => {
        // Redis is not load-bearing: an unreachable cache degrades this to a
        // null version rather than failing the call (DD-005).
        let corpusVersion: number | null = null;
        try {
          corpusVersion = await deps.cache.getCorpusVersion();
        } catch (error: unknown) {
          deps.log.warn(
            { tool: TOOL_NAME, error: describeUnknown(error) },
            "corpus version unavailable, reporting cache down",
          );
        }

        return {
          structured: {
            ok: true,
            corpus_version: corpusVersion,
            cache: corpusVersion === null ? ("down" as const) : ("up" as const),
            compaction_enabled: deps.config.COMPACTION_ENABLED,
            ...(echo === undefined ? {} : { echo }),
          },
          text:
            corpusVersion === null
              ? "Strata is up. Cache unavailable, so recall will run uncached."
              : `Strata is up, serving corpus version ${String(corpusVersion)}.`,
        };
      }),
  );
}
