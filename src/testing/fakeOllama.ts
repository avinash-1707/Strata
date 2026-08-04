import { StrataError } from "../errors.js";
import { assertEmbeddingDimensions, EMBEDDING_DIMENSIONS } from "../ollama/embedding.js";
import type { Embedding, EmbeddingKind, GenerateOptions, Ollama } from "../ollama/types.js";

/**
 * An in-memory `Ollama` whose failure modes are selected rather than simulated.
 * No mode sleeps: a real 5s timeout is a property of the client, and reproducing
 * it here would cost five seconds per degradation test while proving nothing about
 * the tool logic under test.
 */
export interface FakeOllama extends Ollama {
  readonly embedCalls: readonly { text: string; kind: EmbeddingKind }[];
  readonly generateCalls: readonly { prompt: string; options: GenerateOptions | undefined }[];
  setEmbedMode(mode: EmbedMode): void;
  setGenerateMode(mode: GenerateMode): void;
  /** Blocks `embed` until the returned function is called. */
  blockEmbed(): () => void;
  /** Blocks `generate` until the returned function is called. */
  blockGenerate(): () => void;
}

export type EmbedMode =
  | "ok"
  /** Transport failure or timeout — OLLAMA_UNAVAILABLE. */
  | "unavailable"
  /** 767 dimensions, to drive the EMBEDDING_DIM_MISMATCH degradation path. */
  | "wrongDimensions"
  /** A well-formed response containing NaN, which pgvector would reject. */
  | "nonFinite";

export type GenerateMode =
  | "ok"
  | "unavailable"
  /** Not JSON at all. */
  | "prose"
  /** JSON with the right shape wrapped in a fenced block and commentary. */
  | "fencedJson"
  /** Valid JSON, wrong field names — parses, fails validation. */
  | "wrongFields"
  /** Cut off mid-object, so no balanced JSON exists to extract. */
  | "truncatedJson"
  /** Empty string, which a reachable-but-confused model does return. */
  | "empty";

export interface FakeOllamaOptions {
  readonly embed?: EmbedMode;
  readonly generate?: GenerateMode;
  readonly model?: string;
  /** Overrides the compression payload used by the "ok" generate mode. */
  readonly compression?: { readonly summary: string; readonly suggested_tags: string[] };
}

const DEFAULT_MODEL = "fake-embed-text";

export function createFakeOllama(options: FakeOllamaOptions = {}): FakeOllama {
  const embedCalls: { text: string; kind: EmbeddingKind }[] = [];
  const generateCalls: { prompt: string; options: GenerateOptions | undefined }[] = [];
  const model = options.model ?? DEFAULT_MODEL;
  const compression = options.compression ?? {
    summary: "A fake compressed summary.",
    suggested_tags: ["fake", "summary"],
  };
  let embedMode: EmbedMode = options.embed ?? "ok";
  let generateMode: GenerateMode = options.generate ?? "ok";
  let embedGate: Promise<void> | undefined;
  let generateGate: Promise<void> | undefined;

  function gate(): { promise: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  return {
    get embedCalls() {
      return embedCalls;
    },
    get generateCalls() {
      return generateCalls;
    },

    setEmbedMode(mode) {
      embedMode = mode;
    },

    setGenerateMode(mode) {
      generateMode = mode;
    },

    blockEmbed() {
      const { promise, release } = gate();
      embedGate = promise;
      return () => {
        embedGate = undefined;
        release();
      };
    },

    blockGenerate() {
      const { promise, release } = gate();
      generateGate = promise;
      return () => {
        generateGate = undefined;
        release();
      };
    },

    async embed(text, kind): Promise<Embedding> {
      embedCalls.push({ text, kind });
      if (embedGate !== undefined) {
        await embedGate;
      }

      switch (embedMode) {
        case "unavailable":
          throw new StrataError("OLLAMA_UNAVAILABLE", "fake ollama: embed unreachable");
        case "wrongDimensions":
          return { vector: deterministicVector(text, EMBEDDING_DIMENSIONS - 1), model };
        case "nonFinite": {
          const vector = deterministicVector(text, EMBEDDING_DIMENSIONS);
          vector[0] = Number.NaN;
          return { vector, model };
        }
        case "ok": {
          const vector = deterministicVector(text, EMBEDDING_DIMENSIONS);
          // The fake validates its own output through the same helper the real
          // client uses, so a bug in the "ok" path surfaces here rather than as a
          // confusing failure inside a tool test.
          assertEmbeddingDimensions(vector, model);
          return { vector, model };
        }
      }
    },

    async generate(prompt, generateOptions): Promise<string> {
      generateCalls.push({ prompt, options: generateOptions });
      if (generateGate !== undefined) {
        await generateGate;
      }

      switch (generateMode) {
        case "unavailable":
          throw new StrataError("OLLAMA_UNAVAILABLE", "fake ollama: generate unreachable");
        case "prose":
          return "I think the key point here is that the user cares about authentication.";
        case "fencedJson":
          return [
            "Sure! Here is the compressed memory:",
            "```json",
            JSON.stringify(compression),
            "```",
            "Let me know if you need anything else.",
          ].join("\n");
        case "wrongFields":
          return JSON.stringify({ text: compression.summary, keywords: compression.suggested_tags });
        case "truncatedJson":
          return `{"summary": "${compression.summary}", "suggested_tags": ["fa`;
        case "empty":
          return "";
        case "ok":
          // Synthesis asks for prose and passes no `format`; compression passes a
          // JSON Schema. Branching on that keeps one fake usable for both.
          return generateOptions?.format === undefined
            ? "A synthesized answer drawn from the candidates."
            : JSON.stringify(compression);
      }
    },
  };
}

/**
 * Same text in, same vector out, and different texts land in different directions
 * — enough for cosine ordering to be meaningful and reproducible without a model.
 */
function deterministicVector(text: string, length: number): number[] {
  let seed = 2166136261;
  for (const char of text) {
    seed = Math.imul(seed ^ char.codePointAt(0)!, 16777619) >>> 0;
  }
  return Array.from({ length }, (_unused, index) => {
    seed = Math.imul(seed ^ (index + 1), 16777619) >>> 0;
    return (seed % 2000) / 1000 - 1;
  });
}
