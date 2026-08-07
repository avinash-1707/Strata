import { describe, expect, it } from "vitest";

import { createHttpApp, MCP_PATH } from "../../src/http/app.js";
import { createMcpHttpHandler } from "../../src/mcp/http.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/* The transport requires both, and rejects a request carrying only one with a 406.
   Every MCP client sends both; curl by hand does not, which is the usual cause of a
   "the endpoint is broken" report. */
const MCP_ACCEPT = "application/json, text/event-stream";

interface Harness {
  readonly app: ReturnType<typeof createHttpApp>;
  readonly deps: FakeDeps;
}

function build(options: FakeDepsOptions = {}): Harness {
  const deps = createFakeDeps(options);
  const app = createHttpApp(deps, {
    allowUnauthenticated: true,
    mcp: createMcpHttpHandler(deps),
  });
  return { app, deps };
}

interface JsonRpcCall {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly id?: number;
}

async function rpc(app: Harness["app"], call: JsonRpcCall): Promise<Response> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method: call.method };
  if (call.params !== undefined) {
    body["params"] = call.params;
  }
  if (call.id !== undefined) {
    body["id"] = call.id;
  }

  return await app.request(MCP_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", accept: MCP_ACCEPT },
    body: JSON.stringify(body),
  });
}

const INITIALIZE: JsonRpcCall = {
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

interface RpcResult {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

async function resultOf(response: Response): Promise<RpcResult> {
  const parsed: unknown = await response.json();
  return parsed as RpcResult;
}

describe("mcp over http: the protocol handshake", () => {
  it("answers initialize with this server's identity", async () => {
    const { app } = build();
    const response = await rpc(app, INITIALIZE);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const { result } = await resultOf(response);
    expect(result).toMatchObject({ serverInfo: { name: "strata", version: "0.0.0" } });
  });

  /* Stateless: the transport issues no session, so a client has nothing to send back
     and nothing on the server expires. A session id here would mean per-session state
     that needs eviction (DD-053). */
  it("issues no session id", async () => {
    const { app } = build();
    const response = await rpc(app, INITIALIZE);

    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("serves tools/list without a prior initialize", async () => {
    const { app } = build();
    const { result } = await resultOf(await rpc(app, { id: 2, method: "tools/list" }));
    const tools = (result?.["tools"] ?? []) as readonly { readonly name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "forget",
      "recall",
      "remember",
      "search_by_tag",
    ]);
  });

  /* The whole point of a fresh server and transport per request: the SDK's stateless
     transport throws on a second handleRequest, so a long-lived pair would serve
     exactly one call and then fail every later one (CVE-2026-25536). */
  it("serves many requests over the life of the app", async () => {
    const { app } = build();

    for (const id of [1, 2, 3]) {
      const response = await rpc(app, { id, method: "tools/list" });
      expect(response.status).toBe(200);
      const { result, error } = await resultOf(response);
      expect(error).toBeUndefined();
      expect(result?.["tools"]).toBeDefined();
    }
  });
});

describe("mcp over http: tool calls reach the same domain logic REST does", () => {
  it("stores a memory through tools/call", async () => {
    const { app, deps } = build();
    const response = await rpc(app, {
      id: 4,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { content: "The daemon serves REST and MCP from one process." },
      },
    });

    expect(response.status).toBe(200);
    const { result } = await resultOf(response);
    expect(result?.["isError"]).toBeFalsy();
    expect(result?.["structuredContent"]).toMatchObject({ status: "compressed" });

    expect(deps.store.rows).toHaveLength(1);
  });

  it("reports a tool failure as an MCP tool error, not an HTTP error", async () => {
    const { app } = build({ store: { down: true } });
    const response = await rpc(app, {
      id: 5,
      method: "tools/call",
      params: { name: "remember", arguments: { content: "durable or nothing" } },
    });

    // The transport succeeded; the tool did not. Collapsing this into a 5xx would make
    // a failed write indistinguishable from an unreachable server.
    expect(response.status).toBe(200);
    const { result } = await resultOf(response);
    expect(result?.["isError"]).toBe(true);
  });
});

describe("mcp over http: method and header handling", () => {
  it.each(["GET", "DELETE"])("answers %s with 405 and an Allow header", async (method) => {
    const { app } = build();
    const response = await app.request(MCP_PATH, { method, headers: { accept: MCP_ACCEPT } });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    // JSON-RPC framing, because the caller on this path parses envelopes.
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });
  });

  it("rejects a POST that does not accept text/event-stream", async () => {
    const { app } = build();
    const response = await app.request(MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
    });

    expect(response.status).toBe(406);
  });

  it("accepts a notification with 202 and no body", async () => {
    const { app } = build();
    const response = await rpc(app, { method: "notifications/initialized" });

    expect(response.status).toBe(202);
  });

  it("rejects a body that is not JSON-RPC", async () => {
    const { app } = build();
    const response = await app.request(MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: "{ not json",
    });

    expect(response.status).toBe(400);
  });
});

describe("mcp over http: authentication", () => {
  function authenticated(options: FakeDepsOptions = {}): Harness {
    const deps = createFakeDeps({
      ...options,
      config: { MCP_AUTH_TOKEN: TOKEN, ...options.config },
    });
    return { app: createHttpApp(deps, { mcp: createMcpHttpHandler(deps) }), deps };
  }

  /* The MCP path is not a second security domain: an unauthenticated agent must not
     reach the corpus by speaking JSON-RPC instead of REST. */
  it("rejects an unauthenticated tools/call", async () => {
    const { app } = authenticated();
    const response = await rpc(app, {
      id: 7,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "anything" } },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="strata"');
  });

  it("rejects an unauthenticated GET before deciding the method is wrong", async () => {
    const { app } = authenticated();
    const response = await app.request(MCP_PATH, { method: "GET" });

    expect(response.status).toBe(401);
  });

  it("serves the same request with the configured token", async () => {
    const { app } = authenticated();
    const response = await app.request(MCP_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: MCP_ACCEPT,
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });
});
