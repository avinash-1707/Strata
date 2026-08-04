import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

const HARNESS = fileURLToPath(new URL("../testing/stdioHarness.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

/** Generous: a cold tsx start compiles the whole graph before the first frame. */
const STARTUP_TIMEOUT_MS = 20_000;

/**
 * Drives the server the way a client actually does — as a separate process with
 * real pipes — because that is the only configuration in which the stdout claim can
 * be tested. In-process, pino writes through its own destination and never touches
 * `process.stdout` at all, so an in-process assertion would pass vacuously.
 */
interface RawFrame {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

interface RawSession {
  send(frame: unknown): void;
  waitForResponses(count: number): Promise<RawFrame[]>;
  /** Closes stdin, which is how a client disconnects without signalling. */
  disconnect(): void;
  signal(name: "SIGINT" | "SIGTERM"): void;
  waitForExit(): Promise<number | null>;
  /** Complete stdout lines that were not parseable JSON. Must always stay empty. */
  readonly malformed: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  kill(): void;
}

function startRaw(): RawSession {
  const child: ChildProcessWithoutNullStreams = spawn(TSX, [HARNESS], {
    stdio: ["pipe", "pipe", "pipe"],
    // Debug level, so the process logs as much as it possibly can while the test
    // asserts that none of it lands on stdout.
    env: { ...process.env, STRATA_LOG_LEVEL: "debug" },
  });

  let stdout = "";
  let stderr = "";
  const frames: RawFrame[] = [];
  const malformed: string[] = [];
  const waiters: (() => void)[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    // Reparsed from scratch on every chunk: the last element of the split is an
    // incomplete line, and rebuilding avoids tracking a partial-frame offset.
    const complete = stdout.split("\n").slice(0, -1);
    frames.length = 0;
    malformed.length = 0;
    for (const line of complete) {
      if (line.trim().length === 0) {
        continue;
      }
      // Parsed defensively on purpose. An unguarded JSON.parse here throws inside a
      // 'data' handler, which surfaces as an uncaught exception in the runner and
      // stops the very test that exists to report the stray output.
      try {
        frames.push(JSON.parse(line) as RawFrame);
      } catch {
        malformed.push(line);
      }
    }
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    send(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    async waitForResponses(count) {
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (frames.filter((frame) => frame.id !== undefined).length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${String(count)} responses.\nstdout: ${stdout}\nstderr: ${stderr}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return frames.filter((frame) => frame.id !== undefined);
    },
    get malformed() {
      return malformed;
    },
    disconnect() {
      child.stdin.end();
    },
    signal(name) {
      child.kill(name);
    },
    waitForExit() {
      return new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.once("exit", (code) => {
          resolve(code);
        });
      });
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    kill() {
      child.kill("SIGTERM");
    },
  };
}

describe("stdio transport: raw stream inspection (DD-026)", { timeout: STARTUP_TIMEOUT_MS }, () => {
  const session = startRaw();

  afterAll(() => {
    session.kill();
  });

  it("answers a full initialize / list / call exchange", async () => {
    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "0.0.0" },
      },
    });
    await session.waitForResponses(1);

    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    session.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "strata_health", arguments: { echo: "raw" } },
    });

    const responses = await session.waitForResponses(3);

    expect(responses.map((frame) => frame.id)).toEqual([1, 2, 3]);
    // A JSON-RPC error would otherwise satisfy "three responses arrived".
    expect(responses.filter((frame) => frame.error !== undefined)).toEqual([]);

    const listed = responses[1]?.result as { tools?: { name: string }[] } | undefined;
    expect(listed?.tools?.map((tool) => tool.name)).toContain("strata_health");

    const called = responses[2]?.result as { isError?: boolean } | undefined;
    expect(called?.isError).toBeFalsy();
  });

  /* The load-bearing assertion of the whole phase: a single stray byte on stdout
     corrupts the JSON-RPC stream and presents to the user as a client-side bug. */
  it("puts nothing on stdout that is not a JSON-RPC frame", () => {
    const lines = session.stdout.split("\n").filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);
    expect(session.malformed).toEqual([]);
    for (const line of lines) {
      const frame: unknown = JSON.parse(line);
      expect(frame).toMatchObject({ jsonrpc: "2.0" });
    }
  });

  it("writes its logs to stderr instead", () => {
    expect(session.stderr).toContain("listening on stdio");
    expect(session.stderr).toContain("tool call completed");
  });

  it("keeps log output off stdout even at debug level", () => {
    expect(session.stdout).not.toContain("listening on stdio");
    expect(session.stdout).not.toContain("tool call completed");
    expect(session.stdout).not.toContain('"level"');
  });

  /* Teardown is reachable from two paths — a signal, and the client just closing the
     stream. The second is the one with no handler to hang it on, so it is the one
     that would silently sever a pg Pool in Phase 4. */
  it("runs teardown and exits cleanly when the client closes the stream", async () => {
    session.disconnect();
    const code = await session.waitForExit();

    expect(code).toBe(0);
    expect(session.stderr).toContain("released resources");
    expect(session.stderr).toContain("client disconnected");
    // Teardown must not have printed anything either.
    expect(session.malformed).toEqual([]);
  });
});

/**
 * The signal path, which is how Claude Code actually stops the server — it sends
 * SIGINT. Tested separately from the stream-close path because they reach teardown
 * through different mechanisms, and only one of them was exercised at first.
 */
describe("stdio transport: teardown on a signal", { timeout: STARTUP_TIMEOUT_MS }, () => {
  it.each([["SIGINT"], ["SIGTERM"]] as const)("releases resources on %s", async (name) => {
    const session = startRaw();
    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "signal-test", version: "0.0.0" },
      },
    });
    await session.waitForResponses(1);

    session.signal(name);
    const code = await session.waitForExit();

    expect(session.stderr).toContain(`"signal":"${name}"`);
    expect(session.stderr).toContain("released resources");
    // Not killed mid-teardown: the handler holds the loop open until close settles.
    expect(code).toBe(0);
    expect(session.malformed).toEqual([]);
  });
});

describe("stdio transport: a real MCP client over a real pipe", { timeout: STARTUP_TIMEOUT_MS }, () => {
  const client = new Client({ name: "stdio-test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [HARNESS],
    // "pipe" rather than "inherit": inheriting would merge the child's stderr into
    // the test runner's, and a crash on startup would be invisible.
    stderr: "pipe",
  });

  afterAll(async () => {
    await client.close();
  });

  it("connects, lists, and calls over the spawned process", async () => {
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("strata_health");

    const result = await client.callTool({
      name: "strata_health",
      arguments: { echo: "over-stdio" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, echo: "over-stdio" });
  });

  it("validates arguments in the spawned process too", async () => {
    const result = await client.callTool({
      name: "strata_health",
      arguments: { echo: 42 },
    });

    expect(result.isError).toBe(true);
  });
});
