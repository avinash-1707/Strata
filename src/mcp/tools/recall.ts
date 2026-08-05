import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { recallInputShape, recallOutputShape } from "../../contracts/recall.js";
import type { RecallOutput } from "../../contracts/recall.js";
import type { ToolDeps } from "../../deps.js";
import { recall } from "../../tools/recall.js";
import { runTool } from "../invoke.js";

const TOOL_NAME = "recall";

export function registerRecallTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Recall",
      description:
        "Search stored memories for what was previously decided, learned, or preferred, " +
        "and get a synthesized answer. Use it before answering questions about past work, " +
        "before re-deciding something that may already be settled, and when a user refers " +
        "to an earlier conversation. Ask a full question rather than keywords — both " +
        "keyword and meaning-based search run over it.",
      inputSchema: recallInputShape,
      outputSchema: recallOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool(TOOL_NAME, deps.log, async () => {
        const found = await recall(input, deps);
        return {
          structured: found,
          text: renderRecall(found),
          log: { resultCount: found.results.length, synthesized: found.answer !== undefined },
        };
      }),
  );
}

/**
 * An agent reading only `content` must still get the answer *and* be able to cite
 * which memories it came from, so the ids travel with the prose.
 */
function renderRecall(found: RecallOutput): string {
  if (found.results.length === 0) {
    return found.answer ?? "No stored memories matched that query.";
  }

  const cited = found.results.map((result) => `- [${result.id}] ${result.summary}`).join("\n");
  return found.answer === undefined
    ? `No synthesized answer is available. Retrieved memories:\n${cited}`
    : `${found.answer}\n\nDrawn from:\n${cited}`;
}
