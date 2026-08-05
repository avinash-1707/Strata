import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { API_PREFIX, createHttpApp } from "../../src/http/app.js";
import { createStrataServer } from "../../src/mcp/server.js";
import type { FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import type { SeedMemory } from "../fakes/fakeStore.js";

/**
 * The point of the surface-agnostic tools layer (DD-036): for the same input, both
 * surfaces must produce the same answer, differing only in transport, status codes
 * and rendering.
 *
 * Each surface gets its own deps seeded identically rather than sharing one, so the
 * first call cannot change what the second sees.
 */
const TOKEN = "0123456789abcdef0123456789abcdef";

/** Fixed ids, so two independently seeded corpora are genuinely comparable. */
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ROWS: readonly SeedMemory[] = [
  { id: ID_A, summary: "Postgres pool exhaustion caused job timeouts", tags: ["postgres"] },
  { id: ID_B, summary: "We chose pgvector for the vector store", tags: ["postgres", "vectors"] },
];

function options(extra: FakeDepsOptions = {}): FakeDepsOptions {
  return { ...extra, store: { rows: ROWS, ...extra.store }, config: { MCP_AUTH_TOKEN: TOKEN } };
}

async function viaMcp(tool: string, args: Record<string, unknown>, extra: FakeDepsOptions = {}) {
  const deps = createFakeDeps(options(extra));
  const server = createStrataServer(deps);
  const client = new Client({ name: "equivalence", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return { structured: result.structuredContent, isError: result.isError === true };
  } finally {
    await client.close();
    await server.close();
  }
}

async function viaRest(
  method: string,
  path: string,
  body: unknown,
  extra: FakeDepsOptions = {},
): Promise<{ structured: unknown; status: number }> {
  const deps = createFakeDeps(options(extra));
  const app = createHttpApp(deps);

  const response = await app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

  return { structured: await response.json(), status: response.status };
}

describe("recall produces the same result on both surfaces", () => {
  it("agrees on results and answer", async () => {
    const input = { query: "postgres pool", k: 5, synthesize: true };

    const mcp = await viaMcp("recall", input);
    const rest = await viaRest("POST", `${API_PREFIX}/recall`, input);

    expect(rest.structured).toEqual(mcp.structured);
  });

  it("agrees when synthesis is off", async () => {
    const input = { query: "postgres pool", synthesize: false };

    const mcp = await viaMcp("recall", input);
    const rest = await viaRest("POST", `${API_PREFIX}/recall`, input);

    expect(rest.structured).toEqual(mcp.structured);
    expect(rest.structured).not.toHaveProperty("answer");
  });

  it("agrees when the model is down", async () => {
    const input = { query: "postgres pool" };
    const degraded: FakeDepsOptions = { ollama: { embed: "unavailable", generate: "unavailable" } };

    const mcp = await viaMcp("recall", input, degraded);
    const rest = await viaRest("POST", `${API_PREFIX}/recall`, input, degraded);

    expect(rest.structured).toEqual(mcp.structured);
  });

  it("agrees on an empty result set", async () => {
    const input = { query: "kubernetes ingress" };

    const mcp = await viaMcp("recall", input);
    const rest = await viaRest("POST", `${API_PREFIX}/recall`, input);

    expect(rest.structured).toEqual(mcp.structured);
  });
});

describe("search_by_tag produces the same result on both surfaces", () => {
  it("agrees on an any-match", async () => {
    const mcp = await viaMcp("search_by_tag", { tags: ["postgres"] });
    const rest = await viaRest("GET", `${API_PREFIX}/memories?tags=postgres`, undefined);

    expect(rest.structured).toEqual(mcp.structured);
  });

  it("agrees on an all-match with a limit", async () => {
    const mcp = await viaMcp("search_by_tag", {
      tags: ["postgres", "vectors"],
      match: "all",
      limit: 5,
    });
    const rest = await viaRest(
      "GET",
      `${API_PREFIX}/memories?tags=postgres,vectors&match=all&limit=5`,
      undefined,
    );

    expect(rest.structured).toEqual(mcp.structured);
  });
});

describe("forget produces the same result on both surfaces", () => {
  it("agrees on a successful delete", async () => {
    const mcp = await viaMcp("forget", { id: ID_A });
    const rest = await viaRest("DELETE", `${API_PREFIX}/memories/${ID_A}`, undefined);

    expect(rest.structured).toEqual(mcp.structured);
    expect(rest.structured).toEqual({ deleted: true });
  });

  it("agrees on an unknown id", async () => {
    const unknown = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const mcp = await viaMcp("forget", { id: unknown });
    const rest = await viaRest("DELETE", `${API_PREFIX}/memories/${unknown}`, undefined);

    expect(rest.structured).toEqual(mcp.structured);
    expect(rest.structured).toEqual({ deleted: false });
  });
});

describe("remember produces the same result on both surfaces", () => {
  /* The id is a fresh UUID per call, so it cannot be compared across two independent
     runs — everything else must match exactly. */
  it("agrees on everything but the generated id", async () => {
    const input = { content: "A durable decision worth keeping.", tags: ["Auth"] };

    const mcp = await viaMcp("remember", input);
    const rest = await viaRest("POST", `${API_PREFIX}/memories`, input);

    const { id: mcpId, ...mcpRest } = mcp.structured as Record<string, unknown>;
    const { id: restId, ...restRest } = rest.structured as Record<string, unknown>;

    expect(restRest).toEqual(mcpRest);
    expect(mcpId).toEqual(expect.any(String));
    expect(restId).toEqual(expect.any(String));
  });

  it("agrees on the degraded status when the model is down", async () => {
    const input = { content: "A durable decision worth keeping." };
    const degraded: FakeDepsOptions = { ollama: { embed: "unavailable", generate: "unavailable" } };

    const mcp = await viaMcp("remember", input, degraded);
    const rest = await viaRest("POST", `${API_PREFIX}/memories`, input, degraded);

    expect((rest.structured as { status: string }).status).toBe("raw");
    expect((mcp.structured as { status: string }).status).toBe("raw");
  });
});

describe("both surfaces reject the same input", () => {
  it.each([
    ["remember", { content: "" }, "POST", `${API_PREFIX}/memories`],
    ["recall", { query: "" }, "POST", `${API_PREFIX}/recall`],
    ["recall", { query: "x", k: 999 }, "POST", `${API_PREFIX}/recall`],
    ["recall", { query: "x", k: 0 }, "POST", `${API_PREFIX}/recall`],
    ["search_by_tag", { tags: [] }, "GET", `${API_PREFIX}/memories`],
    ["forget", { id: "not-a-uuid" }, "DELETE", `${API_PREFIX}/memories/not-a-uuid`],
  ] as const)("both reject %s with %o", async (tool, args, method, path) => {
    const mcp = await viaMcp(tool, args);
    const rest = await viaRest(method, path, method === "GET" ? undefined : args);

    // MCP reports a rejection as an error *result* so the model can correct and
    // retry; REST reports it as a 400. Different spellings of the same verdict.
    expect(mcp.isError).toBe(true);
    expect(rest.status).toBe(400);
  });

  it("rejects a control character in content on both surfaces", async () => {
    const input = { content: "ok", tags: ["bad\u0000tag"] };

    const mcp = await viaMcp("remember", input);
    const rest = await viaRest("POST", `${API_PREFIX}/memories`, input);

    expect(mcp.isError).toBe(true);
    expect(rest.status).toBe(400);
  });
});

describe("both surfaces fail together when Postgres is down", () => {
  it.each([
    ["recall", { query: "x" }, "POST", `${API_PREFIX}/recall`],
    ["search_by_tag", { tags: ["postgres"] }, "GET", `${API_PREFIX}/memories?tags=postgres`],
    ["remember", { content: "x" }, "POST", `${API_PREFIX}/memories`],
  ] as const)("%s fails on both", async (tool, args, method, path) => {
    const down: FakeDepsOptions = { store: { down: true } };

    const mcp = await viaMcp(tool, args, down);
    const rest = await viaRest(method, path, method === "GET" ? undefined : args, down);

    expect(mcp.isError).toBe(true);
    expect(rest.status).toBe(503);
  });
});
