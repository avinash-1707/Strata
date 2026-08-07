import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ToolDeps } from "../deps.js";
import { describeUnknown } from "../errors.js";
import type { ToolRegistrar } from "./server.js";
import { createStrataServer } from "./server.js";

/** Fetch-API shaped so `src/http` can mount it without importing this module's guts. */
export type McpHttpHandler = (request: Request) => Promise<Response>;

export interface McpHttpOptions {
  /** Test-only tools. Nothing in `src` passes this. */
  readonly extraTools?: readonly ToolRegistrar[];
}

/**
 * MCP over Streamable HTTP — the transport the cross-host deployment uses (DD-036),
 * mounted on the same Hono app as REST so one process serves both.
 *
 * The SDK's own web-standard transport rather than `@hono/mcp`: that package
 * reimplements the transport without the request-collision guard the SDK added for
 * CVE-2026-25536, and drags in OAuth machinery (`pkce-challenge`,
 * `hono-rate-limiter`) for a server whose auth is one bearer token (DD-053).
 */
export function createMcpHttpHandler(deps: ToolDeps, options: McpHttpOptions = {}): McpHttpHandler {
  return async (request) => {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }

    /* A fresh server and transport per request, not a long-lived pair. Sharing either
       across requests routes one client's response to another's connection
       (CVE-2026-25536); the SDK enforces it by throwing on a stateless transport's
       second handleRequest. The stateful alternative — a session map keyed by
       Mcp-Session-Id — would add eviction and leak SSE streams to buy notifications
       and resumability that no Strata tool produces. */
    const server = createStrataServer(deps, options.extraTools ?? []);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Omitting sessionIdGenerator *is* stateless mode: no session to issue,
      // validate, or expire. exactOptionalPropertyTypes forbids passing undefined.
      //
      // JSON mode is load-bearing for the close() below: it resolves with a fully
      // buffered body, so teardown cannot truncate a response still streaming. It
      // also costs nothing here — every tool is request/response.
      enableJsonResponse: true,
    });

    /* Protocol-level rejections (a bad Accept header, unparseable JSON-RPC) are
       returned to the client as an HTTP error *and* reported here. Without this they
       are invisible on the server, and a client failing to connect looks like a
       Strata outage. */
    server.server.onerror = (error: Error) => {
      deps.log.warn(
        { surface: "mcp-http", error: describeUnknown(error) },
        "mcp protocol error",
      );
    };

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      // Closes the transport too. Swallowing nothing: a failed close is logged, and
      // must not replace the response this request already produced.
      await closeQuietly(server, deps);
    }
  };
}

async function closeQuietly(server: McpServer, deps: ToolDeps): Promise<void> {
  try {
    await server.close();
  } catch (error: unknown) {
    deps.log.warn(
      { surface: "mcp-http", error: describeUnknown(error) },
      "closing the per-request mcp server failed",
    );
  }
}

/**
 * GET would open a standalone SSE stream for server-initiated messages and DELETE
 * would end a session; stateless mode has neither. 405 is the spec's answer for a
 * server that offers no server-initiated stream — a 404 from the app's notFound
 * handler would instead tell the client it has the wrong endpoint.
 *
 * JSON-RPC framing, not the REST error body: the only caller on this path is an MCP
 * client, which parses the envelope.
 */
function methodNotAllowed(): Response {
  const body = {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this endpoint accepts POST." },
    id: null,
  };
  return new Response(JSON.stringify(body), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
}
