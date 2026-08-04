import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { healthInputShape, healthOutputShape } from "../../contracts/health.js";
import type { ToolDeps } from "../../deps.js";
import { health } from "../../tools/health.js";
import { runTool } from "../invoke.js";

const TOOL_NAME = "strata_health";

/**
 * A registrar: schema, description, and rendering. All logic lives in
 * `src/tools/health.ts` so the HTTP surface can call the same function.
 */
export function registerHealthTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Strata health",
      // A description is judged by the calls it produces (DD-018). An earlier draft
      // read "useful for confirming the connection before relying on memory tools",
      // which is an instruction to burn a round trip at the top of every session.
      description:
        "Diagnostic only: reports whether the Strata memory server is reachable. " +
        "Do not call this while answering a user request — it stores and retrieves " +
        "nothing. Use it only when explicitly asked to check the connection.",
      inputSchema: healthInputShape,
      outputSchema: healthOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool(TOOL_NAME, deps.log, async () => {
        const report = await health(input, deps);
        return {
          structured: report,
          text:
            report.cache === "down"
              ? "Strata is up. Cache unavailable, so recall will run uncached."
              : `Strata is up, serving corpus version ${String(report.corpus_version)}.`,
          log: { cache: report.cache },
        };
      }),
  );
}
