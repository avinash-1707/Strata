import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { forgetInputShape, forgetOutputShape } from "../../contracts/forget.js";
import type { ToolDeps } from "../../deps.js";
import { forget } from "../../tools/forget.js";
import { runTool } from "../invoke.js";

const TOOL_NAME = "forget";

/**
 * `restore` has no registrar: it is an operator action, and every extra tool dilutes
 * selection of `remember` and `recall`. REST-only by default (DD-039).
 */
export function registerForgetTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Forget",
      description:
        "Remove a memory from future recall, by id. Use it when a stored memory has become " +
        "wrong or was superseded, or when a user asks you to forget something. " +
        "Recall the memory first to get its id and confirm it is the right one.",
      inputSchema: forgetInputShape,
      outputSchema: forgetOutputShape,
      annotations: {
        readOnlyHint: false,
        // The row is retained with `deleted_at` set, so a repeat call is a no-op
        // returning `{deleted: false}` rather than a second deletion (DD-012).
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(TOOL_NAME, deps.log, async () => {
        const result = await forget(input, deps);
        return {
          structured: result,
          text: result.deleted
            ? `Memory ${input.id} will no longer be recalled.`
            : `No live memory has id ${input.id}; nothing was deleted.`,
          log: { id: input.id, deleted: result.deleted },
        };
      }),
  );
}
