import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { wrapError } from "../../src/errors.js";
import { createStrataServer } from "../../src/mcp/server.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";

interface Harness {
  readonly client: Client;
  readonly deps: FakeDeps;
  close(): Promise<void>;
}

async function connect(options: FakeDepsOptions = {}): Promise<Harness> {
  const deps = createFakeDeps(options);
  const server = createStrataServer(deps);
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

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("the MCP registrars carry no logic of their own", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await connect();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("remember returns the stored memory as both text and structured content", async () => {
    const result = await harness.client.callTool({
      name: "remember",
      arguments: { content: "We chose pgvector because the corpus is small." },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "compressed" });
    expect(textOf(result as CallToolResult)).toContain("Stored memory");
  });

  it("remember tells the caller when the memory is stored but not yet compressed", async () => {
    const degraded = await connect({ ollama: { generate: "unavailable" } });

    try {
      const result = await degraded.client.callTool({
        name: "remember",
        arguments: { content: "something durable" },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: "raw" });
      // A caller that only reads text must still learn the write degraded.
      expect(textOf(result as CallToolResult)).toContain("Compression is pending");
    } finally {
      await degraded.close();
    }
  });

  it("recall cites the memory ids alongside the answer", async () => {
    const [seeded] = harness.deps.store.seed([{ summary: "postgres pool exhaustion" }]);

    const result = await harness.client.callTool({
      name: "recall",
      arguments: { query: "postgres pool" },
    });

    const text = textOf(result as CallToolResult);
    // An agent reading only `content` must still be able to attribute the answer.
    expect(text).toContain(`[${seeded!.id}]`);
    expect(text).toContain("Drawn from:");
  });

  it("recall reports retrieved memories even when synthesis failed", async () => {
    const degraded = await connect({ ollama: { generate: "unavailable" } });
    degraded.deps.store.seed([{ summary: "postgres pool exhaustion" }]);

    try {
      const result = await degraded.client.callTool({
        name: "recall",
        arguments: { query: "postgres pool" },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result as CallToolResult)).toContain("No synthesized answer");
      expect(result.structuredContent).toMatchObject({ results: expect.any(Array) });
    } finally {
      await degraded.close();
    }
  });

  it("search_by_tag lists what it found", async () => {
    const [seeded] = harness.deps.store.seed([{ summary: "chose pgvector", tags: ["postgres"] }]);

    const result = await harness.client.callTool({
      name: "search_by_tag",
      arguments: { tags: ["postgres"] },
    });

    expect(textOf(result as CallToolResult)).toContain(`[${seeded!.id}]`);
  });

  it("search_by_tag says so plainly when nothing carries the tag", async () => {
    const result = await harness.client.callTool({
      name: "search_by_tag",
      arguments: { tags: ["nothing"] },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result as CallToolResult)).toContain("No memories are tagged");
  });

  it("forget distinguishes a delete from an unknown id in its text", async () => {
    const [row] = harness.deps.store.seed([{ summary: "s" }]);

    const deleted = await harness.client.callTool({
      name: "forget",
      arguments: { id: row!.id },
    });
    const again = await harness.client.callTool({
      name: "forget",
      arguments: { id: row!.id },
    });

    expect(textOf(deleted as CallToolResult)).toContain("will no longer be recalled");
    expect(textOf(again as CallToolResult)).toContain("nothing was deleted");
  });

  /* DD-039: restore is an operator action. Every extra tool dilutes selection of
     remember and recall, so it is reachable over REST only. */
  it("does not expose restore as a tool", async () => {
    const result = await harness.client.callTool({ name: "restore", arguments: { id: "x" } });

    expect(result.isError).toBe(true);
  });
});

describe("a tool failure reaches the agent as an actionable result", () => {
  it.each(["remember", "recall", "search_by_tag", "forget"] as const)(
    "%s reports a Postgres outage with isError rather than throwing",
    async (name) => {
      const harness = await connect({ store: { down: true } });
      const argumentsByTool: Record<string, Record<string, unknown>> = {
        remember: { content: "x" },
        recall: { query: "x" },
        search_by_tag: { tags: ["x"] },
        forget: { id: "11111111-1111-4111-8111-111111111111" },
      };

      try {
        const result = await harness.client.callTool({
          name,
          arguments: argumentsByTool[name] ?? {},
        });

        expect(result.isError).toBe(true);
        // The code travels so an agent can tell "retry later" from "fix your input".
        expect(textOf(result as CallToolResult)).toContain("DB_QUERY_FAILED");
      } finally {
        await harness.close();
      }
    },
  );

  /* Invariant 8 / DD-032 item 14. A driver error's text carries the failing
     statement, its parameter values, and the DSN's credentials, and a tool result is
     read by a model and kept in a client transcript. So the error is built the way
     the real client builds one — wrapError, which keeps only the authored prefix
     public — and the credential must not appear. */
  it("sends the authored message and not the wrapped driver text", async () => {
    const harness = await connect();
    const driverFailure = new Error(
      "connect ECONNREFUSED postgres://strata:s3cret@10.0.0.4:5432/strata",
    );
    harness.deps.store.setFailure(
      "searchByTag",
      wrapError("DB_QUERY_FAILED", "Database query failed", driverFailure),
    );

    try {
      const result = await harness.client.callTool({
        name: "search_by_tag",
        arguments: { tags: ["postgres"] },
      });
      const text = textOf(result as CallToolResult);

      expect(result.isError).toBe(true);
      expect(text).toContain("Database query failed");
      expect(text).not.toContain("s3cret");
      expect(text).not.toContain("ECONNREFUSED");
    } finally {
      await harness.close();
    }
  });

  it("rejects input the contract forbids before the handler runs", async () => {
    const harness = await connect();

    try {
      const result = await harness.client.callTool({
        name: "recall",
        arguments: { query: "x", k: 999 },
      });

      expect(result.isError).toBe(true);
      // The handler never ran, so nothing was searched.
      expect(harness.deps.store.calls).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
