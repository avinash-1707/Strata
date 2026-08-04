import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { describe, expect, it } from "vitest";

import { StrataError, wrapError } from "../../src/errors.js";
import type { LogContext, Logger } from "../../src/logger.js";
import { runTool } from "../../src/mcp/invoke.js";

interface Line {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly context: LogContext;
  readonly message: string;
}

function recordingLogger(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log: Logger = {
    debug: (context, message) => lines.push({ level: "debug", context, message }),
    info: (context, message) => lines.push({ level: "info", context, message }),
    warn: (context, message) => lines.push({ level: "warn", context, message }),
    error: (context, message) => lines.push({ level: "error", context, message }),
    child: () => log,
  };
  return { log, lines };
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("runTool: success", () => {
  it("returns both text and structured content", async () => {
    const { log } = recordingLogger();
    const result = await runTool("demo", log, () =>
      Promise.resolve({ structured: { count: 2 }, text: "two results" }),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("two results");
    expect(result.structuredContent).toEqual({ count: 2 });
  });

  it("emits exactly one log line, at info, carrying tool and duration", async () => {
    const { log, lines } = recordingLogger();
    await runTool("demo", log, () => Promise.resolve({ structured: {}, text: "" }));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.context).toMatchObject({ tool: "demo", outcome: "ok" });
    expect(lines[0]?.context["durationMs"]).toBeTypeOf("number");
  });

  /* Observability requires result count and cache hit/miss on the *same* line as
     tool and duration; a second line would make an aggregator see two records per
     call. */
  it("merges the payload's log context into that one line", async () => {
    const { log, lines } = recordingLogger();
    await runTool("recall", log, () =>
      Promise.resolve({
        structured: {},
        text: "",
        log: { resultCount: 3, cache: "miss" },
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.context).toMatchObject({
      tool: "recall",
      outcome: "ok",
      resultCount: 3,
      cache: "miss",
    });
  });

  it("does not let the payload overwrite tool or outcome", async () => {
    const { log, lines } = recordingLogger();
    await runTool("recall", log, () =>
      Promise.resolve({ structured: {}, text: "", log: { tool: "spoofed", outcome: "error" } }),
    );

    expect(lines[0]?.context).toMatchObject({ tool: "recall", outcome: "ok" });
  });
});

describe("runTool: failure", () => {
  it("returns isError with the StrataError code rather than throwing", async () => {
    const { log } = recordingLogger();
    const result = await runTool("demo", log, () =>
      Promise.reject(new StrataError("DB_QUERY_FAILED", "could not store the memory")),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DB_QUERY_FAILED");
    expect(textOf(result)).toContain("could not store the memory");
  });

  it("reports UNEXPECTED for a non-StrataError", async () => {
    const { log } = recordingLogger();
    const result = await runTool("demo", log, () => Promise.reject(new Error("kaboom")));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNEXPECTED");
  });

  it("catches a synchronous throw from the work function", async () => {
    const { log } = recordingLogger();
    const result = await runTool("demo", log, () => {
      throw new StrataError("INVALID_INPUT", "bad input");
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_INPUT");
  });

  it("logs the failure once, at error, with the code", async () => {
    const { log, lines } = recordingLogger();
    await runTool("demo", log, () =>
      Promise.reject(new StrataError("OLLAMA_UNAVAILABLE", "unreachable")),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.context).toMatchObject({
      tool: "demo",
      outcome: "error",
      code: "OLLAMA_UNAVAILABLE",
    });
  });

  it("omits structuredContent on failure", async () => {
    const { log } = recordingLogger();
    const result = await runTool("demo", log, () => Promise.reject(new Error("x")));
    expect(result.structuredContent).toBeUndefined();
  });

  /* The tool result is read by a model and kept in a client transcript. A wrapped
     pg error's text carries the failing statement, its parameter values — which are
     memory content — and a DSN's credentials. */
  it("keeps the wrapped cause out of the response while logging it", async () => {
    const { log, lines } = recordingLogger();
    const cause = new Error(
      "duplicate key: (content_hash)=(abc) summary='the user private note' at postgres://u:pw@h/db",
    );
    const result = await runTool("remember", log, () =>
      Promise.reject(wrapError("DB_QUERY_FAILED", "could not store the memory", cause)),
    );

    const text = textOf(result);
    expect(text).toContain("could not store the memory");
    expect(text).not.toContain("private note");
    expect(text).not.toContain("pw@h");
    expect(text).not.toContain("content_hash");

    // Still diagnosable on stderr.
    expect(JSON.stringify(lines[0]?.context)).toContain("private note");
  });

  it("says nothing specific for a thrown non-Error", async () => {
    const { log } = recordingLogger();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const result = await runTool("demo", log, () => Promise.reject({ secret: "leak me" }));

    expect(textOf(result)).not.toContain("leak me");
    expect(textOf(result)).toContain("unexpected internal error");
  });
});

/**
 * Pins an SDK behavior all four Phase 3 tools depend on: a tool that declares an
 * `outputSchema` may still return `isError: true` with no `structuredContent`. If a
 * future SDK version drops that allowance, every tool's failure path breaks at once,
 * and nothing else in the suite would catch it.
 */
describe("runTool over a real client, with an outputSchema declared", () => {
  async function callFailingTool(): Promise<CallToolResult> {
    const { log } = recordingLogger();
    const server = new McpServer({ name: "test", version: "0.0.0" });

    server.registerTool(
      "always_fails",
      {
        description: "Always fails, to exercise the error path.",
        inputSchema: {},
        outputSchema: { value: z.string() },
      },
      () => runTool("always_fails", log, () => Promise.reject(new StrataError("NOT_FOUND", "gone"))),
    );

    const client = new Client({ name: "c", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      return (await client.callTool({ name: "always_fails", arguments: {} })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("delivers the error result instead of a schema violation", async () => {
    const result = await callFailingTool();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
    // Specifically not "no structured content was provided", which is what the SDK
    // would say if it validated output before checking isError.
    expect(textOf(result)).not.toContain("structured content");
  });
});
