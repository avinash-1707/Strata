import { describe, expect, it } from "vitest";

import { API_PREFIX, createHttpApp } from "../../src/http/app.js";
import { isStrataError, StrataError } from "../../src/errors.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function build(options: FakeDepsOptions = {}): { app: ReturnType<typeof createHttpApp>; deps: FakeDeps } {
  const deps = createFakeDeps({ ...options, config: { MCP_AUTH_TOKEN: TOKEN, ...options.config } });
  return { app: createHttpApp(deps), deps };
}

function authorized(path: string, token = TOKEN): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("http app: construction", () => {
  /* MCP_AUTH_TOKEN is optional in config because stdio has nothing to authenticate.
     Serving HTTP without it would expose the corpus to the LAN, so this must fail at
     boot rather than on the first request. */
  it("refuses to build without an auth token", () => {
    const deps = createFakeDeps();
    expect(() => createHttpApp(deps)).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("builds when a token is configured", () => {
    expect(() => build()).not.toThrow();
  });
});

describe("http app: authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const { app } = build();
    const response = await app.request(`${API_PREFIX}/health`);

    expect(response.status).toBe(401);
    // A 401 without this header is malformed per RFC 9110.
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="strata"');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", message: "unauthorized" },
    });
  });

  it.each([
    ["a wrong token of equal length", "f".repeat(TOKEN.length)],
    ["a token that is a prefix of the real one", TOKEN.slice(0, -1)],
    ["a token with extra characters", `${TOKEN}x`],
    ["an empty token", ""],
  ])("rejects %s", async (_label, token) => {
    const { app } = build();
    const response = await app.request(authorized(`${API_PREFIX}/health`, token));
    expect(response.status).toBe(401);
  });

  it("rejects a non-Bearer scheme carrying the right secret", async () => {
    const { app } = build();
    const response = await app.request(
      new Request(`http://localhost${API_PREFIX}/health`, {
        headers: { authorization: `Basic ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    const { app } = build();
    const response = await app.request(authorized(`${API_PREFIX}/health`));
    expect(response.status).toBe(200);
  });

  /* Distinguishing "missing" from "wrong" would tell an attacker which half to work
     on. The distinction is logged, never returned. */
  it("does not reveal why authentication failed", async () => {
    const { app } = build();
    const missing = await (await app.request(`${API_PREFIX}/health`)).json();
    const wrong = await (
      await app.request(authorized(`${API_PREFIX}/health`, "f".repeat(TOKEN.length)))
    ).json();

    expect(missing).toEqual(wrong);
  });
});

describe("http app: the health route", () => {
  it("returns the same contract value the MCP surface serves", async () => {
    const { app } = build({ cache: { initialVersion: 9 } });
    const response = await app.request(authorized(`${API_PREFIX}/health`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      corpus_version: 9,
      cache: "up",
      compaction_enabled: false,
    });
  });

  it("echoes a query parameter", async () => {
    const { app } = build();
    const response = await app.request(authorized(`${API_PREFIX}/health?echo=abc`));
    await expect(response.json()).resolves.toMatchObject({ echo: "abc" });
  });

  it("rejects a query parameter that violates the shared schema", async () => {
    const { app } = build();
    const tooLong = "x".repeat(201);
    const response = await app.request(authorized(`${API_PREFIX}/health?echo=${tooLong}`));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  /* Redis is not load-bearing, so a degraded report is a 200 (DD-005). Returning 503
     here would make scripts retry a condition that will not improve. */
  it("returns 200 with cache down when Redis is unreachable", async () => {
    const { app } = build({ cache: { down: true } });
    const response = await app.request(authorized(`${API_PREFIX}/health`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cache: "down",
      corpus_version: null,
    });
  });
});

describe("http app: error mapping", () => {
  it("returns 404 with a structured body for an unknown endpoint", async () => {
    const { app } = build();
    const response = await app.request(authorized("/v1/nope"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it.each([
    ["DB_QUERY_FAILED", 503],
    ["OLLAMA_UNAVAILABLE", 503],
    ["OLLAMA_BAD_RESPONSE", 502],
    ["NOT_FOUND", 404],
    ["UNAUTHORIZED", 401],
    ["INVALID_INPUT", 400],
    ["EMBEDDING_DIM_MISMATCH", 500],
    ["CONFIG_INVALID", 500],
  ] as const)("maps %s to %i", async (code, expected) => {
    const deps = createFakeDeps({ config: { MCP_AUTH_TOKEN: TOKEN } });
    const app = createHttpApp(deps);
    app.get("/v1/boom", () => {
      throw new StrataError(code, "authored message");
    });

    const response = await app.request(authorized("/v1/boom"));
    expect(response.status).toBe(expected);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  /* A REST body reaches browser consoles and proxy logs — a wider audience than an MCP
     transcript — so it must carry no cause text at all. */
  it("never returns a wrapped cause, only the authored message", async () => {
    const deps = createFakeDeps({ config: { MCP_AUTH_TOKEN: TOKEN } });
    const app = createHttpApp(deps);
    app.get("/v1/leak", () => {
      throw new StrataError("DB_QUERY_FAILED", "could not read memories: postgres://u:pw@h/db", {
        publicMessage: "could not read memories",
      });
    });

    const body = await (await app.request(authorized("/v1/leak"))).json();
    expect(JSON.stringify(body)).not.toContain("pw@h");
    expect(body).toMatchObject({ error: { message: "could not read memories" } });
  });

  it("reports an unexpected non-Strata error as 500 without detail", async () => {
    const deps = createFakeDeps({ config: { MCP_AUTH_TOKEN: TOKEN } });
    const app = createHttpApp(deps);
    app.get("/v1/oops", () => {
      throw new Error("EACCES /etc/shadow");
    });

    const response = await app.request(authorized("/v1/oops"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("shadow");
    expect(body).toMatchObject({ error: { code: "UNEXPECTED" } });
  });
});

describe("http app: every error code has an explicit status", () => {
  /* A Record over the code union means adding a code fails to compile until its status
     is chosen. This asserts the mapping is total, so the check cannot be satisfied by
     a default that turns every new failure into a 500. */
  it("covers the whole StrataErrorCode union", async () => {
    const { statusForError } = await import("../../src/http/errors.js");
    const codes = [
      "CONFIG_INVALID",
      "DB_QUERY_FAILED",
      "CACHE_UNAVAILABLE",
      "OLLAMA_UNAVAILABLE",
      "OLLAMA_BAD_RESPONSE",
      "EMBEDDING_DIM_MISMATCH",
      "NOT_FOUND",
      "UNAUTHORIZED",
      "INVALID_INPUT",
    ] as const;

    for (const code of codes) {
      const error = new StrataError(code, "x");
      expect(isStrataError(error)).toBe(true);
      expect(statusForError(error)).toBeGreaterThanOrEqual(400);
    }
  });
});
