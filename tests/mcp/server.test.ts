import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StrataError } from "../../src/errors.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import { createStrataServer, SERVER_NAME, SERVER_VERSION } from "../../src/mcp/server.js";
import { PROBE_TOOL_NAME, registerProbeTool } from "../support/probeTool.js";

interface Harness {
  readonly client: Client;
  readonly deps: FakeDeps;
  close(): Promise<void>;
}

async function connect(options: FakeDepsOptions = {}): Promise<Harness> {
  const deps = createFakeDeps(options);
  const server = createStrataServer(deps, [registerProbeTool]);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    deps,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The SDK types content loosely; every assertion here needs the text back. */
function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("a real MCP client against the server", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await connect();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("reports its identity during initialize", () => {
    expect(harness.client.getServerVersion()).toMatchObject({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  it("lists the registered tool with a description and an input schema", async () => {
    const { tools } = await harness.client.listTools();
    const probe = tools.find((tool) => tool.name === PROBE_TOOL_NAME);

    expect(probe).toBeDefined();
    expect(probe?.description ?? "").not.toBe("");
    expect(probe?.inputSchema).toMatchObject({ type: "object" });
  });

  /* The four product tools, and only those, reach an agent. `restore` is REST-only
     (DD-039), and the retired strata_health must not come back. */
  it("registers exactly the four product tools, unprefixed", async () => {
    const { tools } = await harness.client.listTools();
    const shipped = tools.map((tool) => tool.name).filter((name) => name !== PROBE_TOOL_NAME);

    expect(shipped.sort()).toEqual(["forget", "recall", "remember", "search_by_tag"]);
  });

  it("gives every shipped tool a non-empty description", async () => {
    const { tools } = await harness.client.listTools();

    // The description is the product surface for an agent-facing server: it decides
    // whether the tool is ever called (DD-018).
    for (const tool of tools) {
      expect(tool.description ?? "", `${tool.name} has no description`).not.toBe("");
    }
  });

  it("derives the wire JSON Schema from the Zod schema", async () => {
    const { tools } = await harness.client.listTools();
    const schema = tools.find((tool) => tool.name === PROBE_TOOL_NAME)?.inputSchema;

    expect(schema?.properties).toMatchObject({ echo: { type: "string" } });
    // `echo` is optional, so requiring it would be a contract break.
    expect(schema?.required ?? []).not.toContain("echo");
  });

  it("calls the tool and returns both text and structured content", async () => {
    const result = await harness.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result as CallToolResult)).toContain("Strata is up");
    expect(result.structuredContent).toMatchObject({
      cache: "up",
      corpus_version: 1,
      compaction_enabled: false,
    });
  });

  it("echoes an optional argument back", async () => {
    const result = await harness.client.callTool({
      name: PROBE_TOOL_NAME,
      arguments: { echo: "correlation-42" },
    });

    expect(result.structuredContent).toMatchObject({ echo: "correlation-42" });
  });

  it("omits echo entirely when it was not supplied", async () => {
    const result = await harness.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });
    expect(result.structuredContent).not.toHaveProperty("echo");
  });
});

describe("schema validation happens before the handler runs", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await connect();
  });

  afterEach(async () => {
    await harness.close();
  });

  /* The SDK validates arguments and short-circuits before invoking the handler, but
     reports the failure as a tool result with isError — not a JSON-RPC error — per
     the spec, so the model can correct its arguments and retry. Asserting on a
     rejected promise here would silently pass for the wrong reason. */
  it("rejects a wrong-typed argument without touching the handler", async () => {
    const result = await harness.client.callTool({
      name: PROBE_TOOL_NAME,
      arguments: { echo: 42 },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("validation");
    // The handler's only dependency call is getCorpusVersion, so an empty call log
    // is direct evidence the handler body never ran. hits+misses cannot show this:
    // neither moves on getCorpusVersion, so that sum is 0 either way.
    expect(harness.deps.cache.calls).toEqual([]);
  });

  it("rejects an argument that violates a schema constraint", async () => {
    const result = await harness.client.callTool({
      name: PROBE_TOOL_NAME,
      arguments: { echo: "x".repeat(201) },
    });

    expect(result.isError).toBe(true);
  });

  it("accepts an argument at the constraint boundary", async () => {
    const result = await harness.client.callTool({
      name: PROBE_TOOL_NAME,
      arguments: { echo: "x".repeat(200) },
    });

    expect(result.isError).toBeFalsy();
  });

  it("reports an unknown tool as an error result rather than crashing", async () => {
    const result = await harness.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("dependency injection and degradation", () => {
  it("uses the injected fakes, with no module-level singleton to reset", async () => {
    const first = await connect({ cache: { initialVersion: 11 } });
    const second = await connect({ cache: { initialVersion: 22 } });

    try {
      const a = await first.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });
      const b = await second.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });

      expect(a.structuredContent).toMatchObject({ corpus_version: 11 });
      expect(b.structuredContent).toMatchObject({ corpus_version: 22 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  /* Redis is not load-bearing: an unreachable cache must degrade to a served
     result with a warning, never to a failed call. */
  it("serves a successful result when the cache is down", async () => {
    const harness = await connect({ cache: { down: true } });

    try {
      const result = await harness.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });

      expect(result.isError).toBeFalsy();
      // A field that can only ever be `true` carries no information, so there is no
      // `ok`: a served response is itself the signal.
      expect(result.structuredContent).toMatchObject({
        cache: "down",
        corpus_version: null,
      });
      expect(textOf(result as CallToolResult)).toContain("uncached");
    } finally {
      await harness.close();
    }
  });

  it("reflects config through the injected deps", async () => {
    const harness = await connect({ config: { COMPACTION_ENABLED: true } });

    try {
      const result = await harness.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });
      expect(result.structuredContent).toMatchObject({ compaction_enabled: true });
    } finally {
      await harness.close();
    }
  });
});

describe("a cache failure degrades rather than failing the call", () => {
  it("serves a degraded result when getCorpusVersion rejects", async () => {
    const harness = await connect();
    // Something the health tool does not guard: the failure must still be caught by
    // the shared wrapper rather than escaping as a protocol error.
    harness.deps.cache.setFailure(
      "getCorpusVersion",
      new StrataError("CACHE_UNAVAILABLE", "connection refused"),
    );

    try {
      const result = await harness.client.callTool({ name: PROBE_TOOL_NAME, arguments: {} });
      // getCorpusVersion is the one call health guards, so this still succeeds —
      // degraded, which is the documented behavior for a cache failure.
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ cache: "down" });
    } finally {
      await harness.close();
    }
  });
});
