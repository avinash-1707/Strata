import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolDeps } from "../deps.js";
import { registerForgetTool } from "./tools/forget.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerSearchByTagTool } from "./tools/searchByTag.js";

export const SERVER_NAME = "strata";

/**
 * Kept in step with package.json by hand. It is reported to the client during
 * initialize, so it must not be read from disk: the compiled server runs from
 * dist, where package.json is not a sibling.
 */
export const SERVER_VERSION = "0.0.0";

export type ToolRegistrar = (server: McpServer, deps: ToolDeps) => void;

/**
 * Every tool registers through this list. Adding a tool means adding a registrar,
 * never adding a branch here — this file wires and nothing else, so that a
 * decision about memory content has nowhere to hide in it.
 *
 * Four tools, deliberately (DD-018): each additional one measurably dilutes the
 * agent's selection of `remember` and `recall`. `restore` is REST-only (DD-039).
 */
const REGISTRARS: readonly ToolRegistrar[] = [
  registerRememberTool,
  registerRecallTool,
  registerSearchByTagTool,
  registerForgetTool,
];

/**
 * `extra` exists so protocol-level tests can register a tool that ships to nobody.
 * Injected rather than gated on an env var, so no production configuration can
 * expose one.
 */
export function createStrataServer(
  deps: ToolDeps,
  extra: readonly ToolRegistrar[] = [],
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const register of [...REGISTRARS, ...extra]) {
    register(server, deps);
  }

  return server;
}
