import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { healthInputShape, healthOutputShape } from "../../src/contracts/health.js";
import type { ToolDeps } from "../../src/deps.js";
import { runTool } from "../../src/mcp/invoke.js";
import { health } from "../../src/tools/health.js";

/**
 * A tool that ships to nobody, registered only by tests through
 * `createStrataServer`'s `extra` parameter.
 *
 * It carries the protocol-level coverage the retired `strata_health` tool used to:
 * that the SDK derives a wire schema from Zod and validates before a handler runs,
 * that `runTool` maps a failure to `isError`, and that `ToolDeps` is genuinely
 * injected. None of that is about memory content, so pinning it to a product tool
 * made those tests fail whenever that tool's wording changed.
 *
 * It reuses `src/tools/health.ts` — still live on the REST surface (DD-043) — so the
 * probe exercises real code rather than a second implementation that could drift.
 */
export const PROBE_TOOL_NAME = "probe";

export function registerProbeTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    PROBE_TOOL_NAME,
    {
      title: "Protocol probe (test-only)",
      description: "Test-only. Reports reachability so protocol behavior can be asserted.",
      inputSchema: healthInputShape,
      outputSchema: healthOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool(PROBE_TOOL_NAME, deps.log, async () => {
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
