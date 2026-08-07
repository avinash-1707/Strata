import { describe, expect, it } from "vitest";

import { API_PREFIX, createHttpApp, MCP_PATH } from "../../src/http/app.js";
import { serveHttp } from "../../src/http/serve.js";
import { createMcpHttpHandler } from "../../src/mcp/http.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import type { RecordedLine, RecordingLogger } from "../support/recordingLogger.js";
import { createRecordingLogger } from "../support/recordingLogger.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/* Port 0 asks the OS for a free one. A fixed port would make this suite fail on a
   machine that happens to be running something there, which reads as a Strata bug. */
const EPHEMERAL = 0;

const LISTEN_TIMEOUT_MS = 5_000;
const POLL_MS = 5;

/**
 * `tests/support/until` drains microtasks, which is right for the fakes and useless
 * here: binding a socket completes on a libuv event, so no number of microtask turns
 * will ever observe it. This is the one suite where waiting on real I/O is the point.
 */
async function waitForLine(log: RecordingLogger, message: string): Promise<RecordedLine> {
  const deadline = Date.now() + LISTEN_TIMEOUT_MS;
  for (;;) {
    const line = log.lines.find((candidate) => candidate.message === message);
    if (line !== undefined) {
      return line;
    }
    if (Date.now() > deadline) {
      throw new Error(`never logged "${message}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

interface Running {
  readonly port: number;
  readonly log: RecordingLogger;
  /** Resolves once the listener has closed and onShutdown has run. */
  readonly finished: Promise<void>;
  readonly shutdowns: number[];
}

/** Held open by the test that needs a request in flight across shutdown. */
let releaseBlockedRoute: (() => void) | undefined;
const BLOCKED_ENTERED = "blocked route entered";

async function start(): Promise<Running> {
  const log = createRecordingLogger();
  const deps = createFakeDeps({ log, config: { MCP_AUTH_TOKEN: TOKEN } });
  const app = createHttpApp(deps, { mcp: createMcpHttpHandler(deps) });
  app.get(`${API_PREFIX}/blocked`, async (context) => {
    log.info({}, BLOCKED_ENTERED);
    await new Promise<void>((resolve) => {
      releaseBlockedRoute = resolve;
    });
    return context.body(null, 204);
  });
  const shutdowns: number[] = [];

  const finished = serveHttp(app, {
    host: "127.0.0.1",
    port: EPHEMERAL,
    log,
    onShutdown: async () => {
      shutdowns.push(Date.now());
      await deps.cache.close();
    },
  });

  // The bound port is only observable through the line an operator reads.
  const listening = await waitForLine(log, "listening on http");
  const port = listening.context["port"];
  if (typeof port !== "number") {
    throw new Error("the listening log line did not carry a port");
  }

  return { port, log, finished, shutdowns };
}

describe("serveHttp: a real listener", () => {
  it("serves REST and MCP from one port, then shuts down on SIGTERM", async () => {
    const running = await start();
    const base = `http://127.0.0.1:${String(running.port)}`;

    const health = await fetch(`${base}${API_PREFIX}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(health.status).toBe(200);

    /* The point of the whole change: both surfaces on one process. This also exercises
       the path `app.request()` cannot — a POST body arriving as a real Node stream and
       being read by the MCP transport's own req.json(). */
    const mcp = await fetch(`${base}${MCP_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "remember", arguments: { content: "served over a real socket" } },
      }),
    });
    expect(mcp.status).toBe(200);
    await expect(mcp.json()).resolves.toMatchObject({
      result: { structuredContent: { status: "compressed" } },
    });

    process.emit("SIGTERM");

    // Resolving is the contract main.ts depends on: `await serveHttp(...)` is the
    // process's lifetime, so a shutdown that never resolves is a container that never
    // exits and gets SIGKILLed.
    await expect(running.finished).resolves.toBeUndefined();
    expect(running.shutdowns).toHaveLength(1);

    // The socket is really gone, not merely refusing new routes.
    await expect(fetch(`${base}${API_PREFIX}/health`)).rejects.toThrow();
  });

  /* Node's close() drops idle keep-alive sockets by itself, but waits forever on a
     socket mid-request — so one slow handler at deploy time means shutdown never
     completes and main.ts's watchdog exits non-zero every time. */
  it("severs a request still in flight after the drain budget", async () => {
    const running = await start();
    const inFlight = fetch(`http://127.0.0.1:${String(running.port)}${API_PREFIX}/blocked`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Waiting on the handler's own line, not a sleep: the socket is provably
    // mid-request when the signal arrives.
    await waitForLine(running.log, BLOCKED_ENTERED);

    process.emit("SIGTERM");
    await expect(running.finished).resolves.toBeUndefined();
    expect(running.log.messages("warn")).toContain("forcing open connections closed");

    releaseBlockedRoute?.();
    await expect(inFlight).rejects.toThrow();
  });

  it("fails the boot when the port is already bound", async () => {
    const running = await start();
    const log = createRecordingLogger();
    const deps = createFakeDeps({ log, config: { MCP_AUTH_TOKEN: TOKEN } });

    /* A daemon that swallowed EADDRINUSE would sit there answering nothing while the
       operator saw a started container. */
    await expect(
      serveHttp(createHttpApp(deps), { host: "127.0.0.1", port: running.port, log }),
    ).rejects.toThrow(/EADDRINUSE/);

    process.emit("SIGTERM");
    await running.finished;
  });
});
