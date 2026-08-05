import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  searchByTagInputShape,
  searchByTagOutputShape,
} from "../../contracts/searchByTag.js";
import type { ToolDeps } from "../../deps.js";
import { searchByTag } from "../../tools/searchByTag.js";
import { runTool } from "../invoke.js";

const TOOL_NAME = "search_by_tag";

export function registerSearchByTagTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Search by tag",
      // Steered away from recall's job on purpose: an agent that reaches here for a
      // question gets exact-match behavior and concludes memory is empty.
      description:
        "List memories carrying specific tags, newest first. This is an exact tag match, " +
        "not a search: use it to enumerate what is stored about a known topic. " +
        "For questions, use recall instead — it searches meaning and returns an answer.",
      inputSchema: searchByTagInputShape,
      outputSchema: searchByTagOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool(TOOL_NAME, deps.log, async () => {
        const found = await searchByTag(input, deps);
        return {
          structured: found,
          text:
            found.results.length === 0
              ? `No memories are tagged ${input.tags.join(", ")}.`
              : found.results.map((row) => `- [${row.id}] ${row.summary}`).join("\n"),
          log: { resultCount: found.results.length, match: input.match },
        };
      }),
  );
}
