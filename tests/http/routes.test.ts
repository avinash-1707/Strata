import { describe, expect, it } from "vitest";

import type { StrataErrorCode } from "../../src/errors.js";
import { StrataError } from "../../src/errors.js";
import { API_PREFIX, createHttpApp } from "../../src/http/app.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface Built {
  readonly app: ReturnType<typeof createHttpApp>;
  readonly deps: FakeDeps;
}

function build(options: FakeDepsOptions = {}): Built {
  const deps = createFakeDeps({
    ...options,
    config: { MCP_AUTH_TOKEN: TOKEN, ...options.config },
  });
  return { app: createHttpApp(deps), deps };
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function send(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("POST /v1/memories", () => {
  it("stores a memory and returns the contract shape", async () => {
    const { app } = build();

    const response = await app.request(
      send("POST", `${API_PREFIX}/memories`, { content: "We chose pgvector." }),
    );

    // 200 rather than 201: DD-020 makes this idempotent and the body is identical
    // whether the memory was created or already existed, so 201 would be a lie half
    // the time.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "compressed" });
  });

  it("returns the same id for identical content (DD-020)", async () => {
    const { app } = build();
    const payload = { content: "We chose pgvector." };

    const first = (await (await app.request(send("POST", `${API_PREFIX}/memories`, payload))).json()) as {
      id: string;
    };
    const second = (await (
      await app.request(send("POST", `${API_PREFIX}/memories`, payload))
    ).json()) as { id: string };

    expect(second.id).toBe(first.id);
  });

  it("still succeeds with a 200 when Ollama is down", async () => {
    const { app } = build({ ollama: { embed: "unavailable", generate: "unavailable" } });

    const response = await app.request(
      send("POST", `${API_PREFIX}/memories`, { content: "durable either way" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "raw" });
  });

  it("rejects a body the contract forbids", async () => {
    const { app } = build();

    const response = await app.request(send("POST", `${API_PREFIX}/memories`, { content: "" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  /* A malformed payload throws inside req.json(). Letting that reach the error
     boundary unlabelled would report a caller's broken JSON as a 500. */
  it("reports malformed JSON as a 400, not a 500", async () => {
    const { app } = build();
    const response = await app.request(
      new Request(`http://localhost${API_PREFIX}/memories`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("never echoes the rejected value back", async () => {
    const { app } = build();
    const response = await app.request(
      send("POST", `${API_PREFIX}/memories`, { content: "ok", tags: ["x".repeat(400)] }),
    );

    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("x".repeat(400));
  });
});

describe("GET /v1/memories", () => {
  it("searches by repeated tag parameters", async () => {
    const { app, deps } = build();
    deps.store.seed([
      { summary: "a", tags: ["postgres"] },
      { summary: "b", tags: ["redis"] },
    ]);

    const response = await app.request(get(`${API_PREFIX}/memories?tags=postgres&tags=redis`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(2);
  });

  /* A query string has no native array, so req.query() keeps only the last value of
     a repeated key — which would silently drop every tag but one. */
  it("also accepts a comma-separated list", async () => {
    const { app, deps } = build();
    deps.store.seed([
      { summary: "a", tags: ["postgres"] },
      { summary: "b", tags: ["redis"] },
    ]);

    const response = await app.request(get(`${API_PREFIX}/memories?tags=postgres,redis`));

    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(2);
  });

  it("honors match=all", async () => {
    const { app, deps } = build();
    deps.store.seed([
      { summary: "both", tags: ["postgres", "vectors"] },
      { summary: "one", tags: ["postgres"] },
    ]);

    const response = await app.request(
      get(`${API_PREFIX}/memories?tags=postgres,vectors&match=all`),
    );

    const body = (await response.json()) as { results: { summary: string }[] };
    expect(body.results.map((row) => row.summary)).toEqual(["both"]);
  });

  it("coerces limit from its string form", async () => {
    const { app, deps } = build();
    deps.store.seed([
      { summary: "a", tags: ["t"] },
      { summary: "b", tags: ["t"] },
    ]);

    const response = await app.request(get(`${API_PREFIX}/memories?tags=t&limit=1`));

    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });

  it("rejects a non-numeric limit", async () => {
    const { app } = build();

    const response = await app.request(get(`${API_PREFIX}/memories?tags=t&limit=lots`));

    expect(response.status).toBe(400);
  });

  it("requires at least one tag", async () => {
    const { app } = build();

    const response = await app.request(get(`${API_PREFIX}/memories`));

    expect(response.status).toBe(400);
  });
});

describe("DELETE /v1/memories/:id", () => {
  it("soft-deletes and reports it", async () => {
    const { app, deps } = build();
    const [row] = deps.store.seed([{ summary: "s" }]);

    const response = await app.request(send("DELETE", `${API_PREFIX}/memories/${row!.id}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
  });

  /* 200 with {deleted: false} rather than a 404: the contract answers this in the
     body (DD-018), and both surfaces must answer the same question the same way. */
  it("reports an unknown id in the body, not as a 404", async () => {
    const { app } = build();

    const response = await app.request(
      send("DELETE", `${API_PREFIX}/memories/11111111-1111-4111-8111-111111111111`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: false });
  });

  it("rejects an id that is not a UUID", async () => {
    const { app } = build();

    const response = await app.request(send("DELETE", `${API_PREFIX}/memories/not-a-uuid`));

    expect(response.status).toBe(400);
  });

  /* DD-039: no bulk endpoint, so a runaway script works one request at a time. */
  it("has no bulk delete route", async () => {
    const { app } = build();

    const response = await app.request(send("DELETE", `${API_PREFIX}/memories`));

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/memories/:id/restore", () => {
  it("brings a forgotten memory back", async () => {
    const { app, deps } = build();
    const [row] = deps.store.seed([{ summary: "s" }]);
    await app.request(send("DELETE", `${API_PREFIX}/memories/${row!.id}`));

    const response = await app.request(
      send("POST", `${API_PREFIX}/memories/${row!.id}/restore`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ restored: true });
  });

  it("reports false for a memory that was never deleted", async () => {
    const { app, deps } = build();
    const [row] = deps.store.seed([{ summary: "s" }]);

    const response = await app.request(
      send("POST", `${API_PREFIX}/memories/${row!.id}/restore`),
    );

    await expect(response.json()).resolves.toEqual({ restored: false });
  });
});

describe("POST /v1/recall", () => {
  it("returns results and an answer", async () => {
    const { app, deps } = build();
    deps.store.seed([{ summary: "postgres pool exhaustion" }]);

    const response = await app.request(
      send("POST", `${API_PREFIX}/recall`, { query: "postgres pool" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[]; answer?: string };
    expect(body.results).toHaveLength(1);
    expect(body.answer).toBeDefined();
  });

  it("applies the contract's defaults", async () => {
    const { app, deps } = build();
    deps.store.seed(
      Array.from({ length: 20 }, (_unused, index) => ({ summary: `pool ${String(index)}` })),
    );

    const response = await app.request(
      send("POST", `${API_PREFIX}/recall`, { query: "pool" }),
    );

    const body = (await response.json()) as { results: unknown[] };
    // DEFAULT_RECALL_K, applied by the same schema the MCP surface uses.
    expect(body.results).toHaveLength(8);
  });

  it("rejects a k above the contract's ceiling", async () => {
    const { app } = build();

    const response = await app.request(
      send("POST", `${API_PREFIX}/recall`, { query: "x", k: 999 }),
    );

    expect(response.status).toBe(400);
  });

  it("fails with 503 when Postgres is down", async () => {
    const { app } = build({ store: { down: true } });

    const response = await app.request(
      send("POST", `${API_PREFIX}/recall`, { query: "x" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "DB_QUERY_FAILED" } });
  });
});

describe("authentication covers every new route", () => {
  it.each([
    ["POST", `${API_PREFIX}/memories`],
    ["GET", `${API_PREFIX}/memories?tags=x`],
    ["DELETE", `${API_PREFIX}/memories/11111111-1111-4111-8111-111111111111`],
    ["POST", `${API_PREFIX}/memories/11111111-1111-4111-8111-111111111111/restore`],
    ["POST", `${API_PREFIX}/recall`],
  ] as const)("%s %s requires a token", async (method, path) => {
    const { app } = build();

    const response = await app.request(
      new Request(`http://localhost${path}`, { method }),
    );

    expect(response.status).toBe(401);
  });
});

/* Every code must be reachable and map to a chosen status — a new failure mode
   silently becoming a 500 is what the exhaustive Record exists to prevent. */
describe("every StrataErrorCode maps to an HTTP status", () => {
  const EXPECTED: Record<StrataErrorCode, number> = {
    CONFIG_INVALID: 500,
    DB_QUERY_FAILED: 503,
    CACHE_UNAVAILABLE: 503,
    OLLAMA_UNAVAILABLE: 503,
    OLLAMA_BAD_RESPONSE: 502,
    EMBEDDING_DIM_MISMATCH: 500,
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    INVALID_INPUT: 400,
  };

  it.each(Object.entries(EXPECTED))("%s becomes %i", async (code, status) => {
    const { app, deps } = build();
    // Injected on a store method a route actually calls, so the error travels the
    // real path through the tool and the surface's error boundary.
    deps.store.setFailure("searchByTag", new StrataError(code as StrataErrorCode, "injected"));

    const response = await app.request(get(`${API_PREFIX}/memories?tags=postgres`));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("reports an unexpected non-StrataError as a 500 without leaking its text", async () => {
    const { app, deps } = build();
    deps.store.setFailure(
      "searchByTag",
      new Error("connect ECONNREFUSED postgres://strata:s3cret@10.0.0.4:5432/strata") as never,
    );

    const response = await app.request(get(`${API_PREFIX}/memories?tags=postgres`));

    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("UNEXPECTED");
    expect(body).not.toContain("s3cret");
  });
});
