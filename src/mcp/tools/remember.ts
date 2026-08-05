import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { rememberInputShape, rememberOutputShape } from "../../contracts/remember.js";
import type { ToolDeps } from "../../deps.js";
import { remember } from "../../tools/remember.js";
import { runTool } from "../invoke.js";

/** DD-038: unprefixed. */
const TOOL_NAME = "remember";

export function registerRememberTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Remember",
      // The description decides whether this tool is ever called, so it names the
      // occasions rather than describing the mechanism (DD-018).
      description:
        "Store a durable fact, decision, or outcome so it survives past this conversation. " +
        "Use it when something is settled that would be expensive to rediscover: a design " +
        "decision and its reasoning, the root cause of a bug, a user's stated preference, " +
        "a convention agreed on. Pass the full content — it is compressed for you. " +
        "Do not use it for transient state, or for anything already in the project's files.",
      inputSchema: rememberInputShape,
      outputSchema: rememberOutputShape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool(TOOL_NAME, deps.log, async () => {
        const stored = await remember(input, deps);
        return {
          structured: stored,
          text:
            stored.status === "raw"
              ? `Stored memory ${stored.id}. Compression is pending, so it is saved as written.`
              : `Stored memory ${stored.id}: ${stored.summary}`,
          log: { id: stored.id, status: stored.status, tagCount: stored.tags.length },
        };
      }),
  );
}
