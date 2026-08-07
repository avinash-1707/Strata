import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import type { Config } from "../../src/config/env.js";
import { createOllamaClient } from "../../src/ollama/client.js";
import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";

function config(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    POSTGRES_URL: "postgres://unused",
    REDIS_URL: "redis://unused",
    OLLAMA_URL: "http://ollama.test:11434",
    EMBEDDING_MODEL: "nomic-embed-text",
    INSTRUCT_MODEL: "qwen2.5:3b-instruct",
    ...overrides,
  });
}

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A fetch that answers every call with `payload` and records what was sent. */
function fakeFetch(
  payload: unknown,
  options: { status?: number; raw?: string } = {},
): { fetchFn: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    sent.push({ url, body: JSON.parse(rawBody) as Record<string, unknown> });
    return Promise.resolve(
      new Response(options.raw ?? JSON.stringify(payload), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchFn, sent };
}

function embedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
}

const EMBED_OK = { model: "nomic-embed-text", embeddings: [Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)] };

describe("ollama client: embed (DD-008)", () => {
  it("prefixes a document and a query differently for the nomic family", async () => {
    const { fetchFn, sent } = fakeFetch(EMBED_OK);
    const client = createOllamaClient(config(), fetchFn);

    await client.embed("stored text", "document");
    await client.embed("a question", "query");

    expect(sent[0]?.body["input"]).toBe("search_document: stored text");
    expect(sent[1]?.body["input"]).toBe("search_query: a question");
  });

  it("prefixes a registry-qualified nomic name — same family, same biencoder", async () => {
    const { fetchFn, sent } = fakeFetch(EMBED_OK);
    const client = createOllamaClient(
      config({ EMBEDDING_MODEL: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF" }),
      fetchFn,
    );

    await client.embed("stored text", "document");

    expect(sent[0]?.body["input"]).toBe("search_document: stored text");
  });

  it("leaves a non-nomic model unprefixed — prefixing it would corrupt embeddings", async () => {
    const { fetchFn, sent } = fakeFetch(EMBED_OK);
    const client = createOllamaClient(config({ EMBEDDING_MODEL: "mxbai-embed-large" }), fetchFn);

    await client.embed("stored text", "document");

    expect(sent[0]?.body["input"]).toBe("stored text");
  });

  it("posts to /api/embed under the configured base URL", async () => {
    const { fetchFn, sent } = fakeFetch(EMBED_OK);
    await createOllamaClient(config(), fetchFn).embed("text", "document");

    expect(sent[0]?.url).toBe("http://ollama.test:11434/api/embed");
    expect(sent[0]?.body["model"]).toBe("nomic-embed-text");
  });

  it("carries the producing model with the vector (DD-009)", async () => {
    const { fetchFn } = fakeFetch({ model: "nomic-embed-text:v1.5", embeddings: [embedding()] });
    const result = await createOllamaClient(config(), fetchFn).embed("text", "document");

    expect(result.model).toBe("nomic-embed-text:v1.5");
    expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("falls back to the requested model when the response omits one", async () => {
    const { fetchFn } = fakeFetch({ embeddings: [embedding()] });
    const result = await createOllamaClient(config(), fetchFn).embed("text", "document");

    expect(result.model).toBe("nomic-embed-text");
  });

  it("rejects a wrong-width vector as EMBEDDING_DIM_MISMATCH", async () => {
    const { fetchFn } = fakeFetch({ embeddings: [[0.1, 0.2, 0.3]] });

    await expect(
      createOllamaClient(config(), fetchFn).embed("text", "document"),
    ).rejects.toMatchObject({ code: "EMBEDDING_DIM_MISMATCH" });
  });

  it("rejects an empty embeddings list as OLLAMA_BAD_RESPONSE", async () => {
    const { fetchFn } = fakeFetch({ embeddings: [] });

    await expect(
      createOllamaClient(config(), fetchFn).embed("text", "document"),
    ).rejects.toMatchObject({ code: "OLLAMA_BAD_RESPONSE" });
  });
});

describe("ollama client: generate (DD-006)", () => {
  it("asks for a non-streamed completion at temperature 0 by default", async () => {
    const { fetchFn, sent } = fakeFetch({ response: "an answer" });
    const client = createOllamaClient(config(), fetchFn);

    await expect(client.generate("a prompt")).resolves.toBe("an answer");

    expect(sent[0]?.url).toBe("http://ollama.test:11434/api/generate");
    expect(sent[0]?.body["stream"]).toBe(false);
    expect(sent[0]?.body["options"]).toEqual({ temperature: 0 });
    expect(sent[0]?.body).not.toHaveProperty("format");
  });

  it("passes a JSON Schema through as format, never format:'json'", async () => {
    const { fetchFn, sent } = fakeFetch({ response: "{}" });
    const schema = { type: "object", properties: { summary: { type: "string" } } };

    await createOllamaClient(config(), fetchFn).generate("compress this", { format: schema });

    expect(sent[0]?.body["format"]).toEqual(schema);
  });

  it("honors a caller-supplied temperature", async () => {
    const { fetchFn, sent } = fakeFetch({ response: "prose" });

    await createOllamaClient(config(), fetchFn).generate("synthesize", { temperature: 0.2 });

    expect(sent[0]?.body["options"]).toEqual({ temperature: 0.2 });
  });

  it("rejects a payload without a response field as OLLAMA_BAD_RESPONSE", async () => {
    const { fetchFn } = fakeFetch({ done: true });

    await expect(createOllamaClient(config(), fetchFn).generate("prompt")).rejects.toMatchObject({
      code: "OLLAMA_BAD_RESPONSE",
    });
  });
});

describe("ollama client: failure split (unreachable vs unusable)", () => {
  it("maps a transport failure to OLLAMA_UNAVAILABLE", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));

    await expect(
      createOllamaClient(config(), fetchFn).embed("text", "document"),
    ).rejects.toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
  });

  it("maps a timeout to OLLAMA_UNAVAILABLE", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
        });
      });

    await expect(
      createOllamaClient(config(), fetchFn).embed("text", "document", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
  });

  it("maps a non-2xx answer to OLLAMA_BAD_RESPONSE, with an authored public message", async () => {
    const { fetchFn } = fakeFetch({ error: "model not found" }, { status: 404 });

    await expect(createOllamaClient(config(), fetchFn).generate("prompt")).rejects.toMatchObject({
      code: "OLLAMA_BAD_RESPONSE",
      publicMessage: "the model service returned an error",
    });
  });

  it("maps a non-JSON body to OLLAMA_BAD_RESPONSE", async () => {
    const { fetchFn } = fakeFetch(undefined, { raw: "<html>gateway error</html>" });

    await expect(createOllamaClient(config(), fetchFn).generate("prompt")).rejects.toMatchObject({
      code: "OLLAMA_BAD_RESPONSE",
    });
  });
});

describe("the ollama client: caller cancellation", () => {
  /** Never answers, so only an abort can end the call. */
  function hangingFetch(): { fetchFn: typeof fetch; seen: (AbortSignal | undefined)[] } {
    const seen: (AbortSignal | undefined)[] = [];
    const fetchFn: typeof fetch = (_input, init) => {
      const signal = init?.signal ?? undefined;
      seen.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    return { fetchFn, seen };
  }

  /* The whole shutdown chain is decorative unless the signal reaches fetch: a pass
     holding a pooled connection through a 60s generation is what blocks pool.end()
     (DD-045). */
  it.each([
    ["generate", (fetchFn: typeof fetch, signal: AbortSignal) =>
      createOllamaClient(config(), fetchFn).generate("prompt", { signal })],
    ["embed", (fetchFn: typeof fetch, signal: AbortSignal) =>
      createOllamaClient(config(), fetchFn).embed("text", "document", { signal })],
  ])("lets a caller's signal cancel %s", async (_label, call) => {
    const { fetchFn } = hangingFetch();
    const controller = new AbortController();
    const inFlight = call(fetchFn, controller.signal);

    controller.abort();

    // OLLAMA_UNAVAILABLE, not a new code: DD-045 classifies that as transport, so the
    // row is stamped and charged nothing — right for a call the process cancelled.
    await expect(inFlight).rejects.toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
  });

  it("still enforces its own timeout when no caller signal is given", async () => {
    const { fetchFn, seen } = hangingFetch();

    await expect(
      createOllamaClient(config(), fetchFn).generate("prompt", { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
