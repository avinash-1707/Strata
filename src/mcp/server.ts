import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolDeps } from "./deps.js";
import { registerHealthTool } from "./tools/health.js";

export const SERVER_NAME = "strata";

/**
 * Kept in step with package.json by hand. It is reported to the client during
 * initialize, so it must not be read from disk: the compiled server runs from
 * dist, where package.json is not a sibling.
 */
export const SERVER_VERSION = "0.0.0";

/**
 * Every tool registers through this list. Adding a tool means adding a registrar,
 * never adding a branch here — this file wires and nothing else, so that a
 * decision about memory content has nowhere to hide in it.
 */
const REGISTRARS: readonly ((server: McpServer, deps: ToolDeps) => void)[] = [
  registerHealthTool,
];

export function createStrataServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const register of REGISTRARS) {
    register(server, deps);
  }

  return server;
}
