import { describe, expect, it } from "vitest";

import { ENHANCEMENT_TIMEOUT_MS } from "../config.js";
import { isStrataError } from "../errors.js";
import { assertEmbeddingDimensions, EMBEDDING_DIMENSIONS } from "../ollama/embedding.js";
import { compressionJsonSchema, parseCompressionResult } from "../ollama/parse.js";
import { createFakeOllama } from "./fakeOllama.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isStrataError(error) ? error.code : "NOT_A_STRATA_ERROR";
  }
  return "NO_THROW";
}

describe("fake ollama: embed", () => {
  it("returns a correctly sized vector with its producing model (DD-009)", async () => {
    const ollama = createFakeOllama({ model: "nomic-embed-text" });
    const { vector, model } = await ollama.embed("hello", "document");

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(model).toBe("nomic-embed-text");
  });

  it("is deterministic for the same text", async () => {
    const ollama = createFakeOllama();
    const a = await ollama.embed("same text", "document");
    const b = await ollama.embed("same text", "document");
    expect(a.vector).toEqual(b.vector);
  });

  it("separates different texts, so cosine ordering means something", async () => {
    const ollama = createFakeOllama();
    const a = await ollama.embed("postgres pooling", "document");
    const b = await ollama.embed("redis eviction", "document");
    expect(a.vector).not.toEqual(b.vector);
  });

  /* DD-008's prefixes are the client's job, keyed off model family, so the seam
     carries the *kind* and no call site can apply a prefix itself. Whether the real
     client applies them correctly is only testable against a model (Phase 6). */
  it("records the kind alongside the unmodified text", async () => {
    const ollama = createFakeOllama();
    await ollama.embed("a query", "query");
    await ollama.embed("a document", "document", { timeoutMs: 5_000 });

    expect(ollama.embedCalls).toEqual([
      { text: "a query", kind: "query", options: undefined },
      { text: "a document", kind: "document", options: { timeoutMs: 5_000 } },
    ]);
  });

  /* DD-005 stage 2 runs inline on the write path and needs a far tighter bound than
     the per-call ceiling, so the budget has to be assertable. */
  it("records the timeout it was given, so the stage-2 budget is assertable", async () => {
    const ollama = createFakeOllama();
    await ollama.embed("x", "document", { timeoutMs: ENHANCEMENT_TIMEOUT_MS });
    expect(ollama.embedCalls[0]?.options).toEqual({ timeoutMs: ENHANCEMENT_TIMEOUT_MS });
  });

  it("raises OLLAMA_UNAVAILABLE in unavailable mode", async () => {
    const ollama = createFakeOllama({ embed: "unavailable" });
    await expect(ollama.embed("x", "document")).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "OLLAMA_UNAVAILABLE",
    );
  });

  it("returns a wrong-width vector that the shared guard rejects", async () => {
    const ollama = createFakeOllama({ embed: "wrongDimensions" });
    const { vector, model } = await ollama.embed("x", "document");

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS - 1);
    expect(codeOf(() => assertEmbeddingDimensions(vector, model))).toBe("EMBEDDING_DIM_MISMATCH");
  });

  it("returns a non-finite component that the shared guard rejects", async () => {
    const ollama = createFakeOllama({ embed: "nonFinite" });
    const { vector, model } = await ollama.embed("x", "document");

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(codeOf(() => assertEmbeddingDimensions(vector, model))).toBe("EMBEDDING_DIM_MISMATCH");
  });

  it("switches mode mid-test, so one deps object covers a recovery path", async () => {
    const ollama = createFakeOllama({ embed: "unavailable" });
    await expect(ollama.embed("x", "document")).rejects.toThrow();
    ollama.setEmbedMode("ok");
    await expect(ollama.embed("x", "document")).resolves.toMatchObject({
      vector: expect.any(Array),
    });
  });
});

describe("fake ollama: generate", () => {
  const format = compressionJsonSchema();

  it("returns schema-valid compression JSON in ok mode", async () => {
    const ollama = createFakeOllama();
    const raw = await ollama.generate("prompt", { format, temperature: 0 });
    expect(parseCompressionResult(raw)).toMatchObject({ summary: expect.any(String) });
  });

  it("returns prose when no format is requested, as synthesis does", async () => {
    const ollama = createFakeOllama();
    const raw = await ollama.generate("prompt");
    expect(raw).not.toContain("{");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("records the options it was called with, so temperature 0 is assertable (DD-006)", async () => {
    const ollama = createFakeOllama();
    await ollama.generate("prompt", { format, temperature: 0 });
    expect(ollama.generateCalls[0]?.options).toMatchObject({ temperature: 0, format });
  });

  it("raises OLLAMA_UNAVAILABLE in unavailable mode", async () => {
    const ollama = createFakeOllama({ generate: "unavailable" });
    await expect(ollama.generate("p", { format })).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "OLLAMA_UNAVAILABLE",
    );
  });

  /* Each of these feeds the Phase 1 parser its own known-bad shapes, but through
     the fake — so a tool test exercises the real degradation decision rather than
     a hand-built string. */
  it("survives a fenced, prose-wrapped response", async () => {
    const ollama = createFakeOllama({ generate: "fencedJson" });
    const raw = await ollama.generate("p", { format });
    expect(parseCompressionResult(raw)).toMatchObject({ summary: expect.any(String) });
  });

  it.each([["prose"], ["wrongFields"], ["truncatedJson"], ["empty"]] as const)(
    "fails deterministically with OLLAMA_BAD_RESPONSE in %s mode",
    async (mode) => {
      const ollama = createFakeOllama({ generate: mode });
      const raw = await ollama.generate("p", { format });
      expect(codeOf(() => parseCompressionResult(raw))).toBe("OLLAMA_BAD_RESPONSE");
    },
  );
});

describe("fake ollama: blocking", () => {
  it("holds a call open until released", async () => {
    const ollama = createFakeOllama();
    const release = ollama.blockEmbed();
    let settled = false;

    const pending = ollama.embed("x", "document").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    // The call was entered even though it has not returned — which is what makes
    // "was this issued concurrently?" answerable without a timer.
    expect(ollama.embedCalls).toHaveLength(1);

    release();
    await pending;
    expect(settled).toBe(true);
  });
});
