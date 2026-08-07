import { StrataError } from "../../src/errors.js";
import { assertEmbeddingDimensions, EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";
import type {
  Embedding,
  EmbeddingKind,
  GenerateOptions,
  ModelCallOptions,
  Ollama,
} from "../../src/ollama/types.js";

/**
 * An in-memory `Ollama` whose failure modes are selected rather than simulated.
 * No mode sleeps: a real 5s timeout is a property of the client, and reproducing
 * it here would cost five seconds per degradation test while proving nothing about
 * the tool logic under test.
 */
export interface FakeOllama extends Ollama {
  readonly embedCalls: readonly {
    text: string;
    kind: EmbeddingKind;
    options: ModelCallOptions | undefined;
  }[];
  readonly generateCalls: readonly { prompt: string; options: GenerateOptions | undefined }[];
  setEmbedMode(mode: EmbedMode): void;
  setGenerateMode(mode: GenerateMode): void;
  /**
   * Makes `generate` time out for prompts containing `marker`, whatever the mode.
   * A whole-service outage and one slow row are the same error code
   * (`AbortSignal.timeout` surfaces as OLLAMA_UNAVAILABLE) but not the same
   * situation: the second must not be able to abort every repair pass forever
   * (DD-045).
   */
  timeOutOn(marker: string): void;
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
  /** Reachable, but the model was never pulled: a 404, which DD-047 makes routine. */
  | "notPulled"
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
  const embedCalls: { text: string; kind: EmbeddingKind; options: ModelCallOptions | undefined }[] =
    [];
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
  let slowMarker: string | undefined;

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

    timeOutOn(marker) {
      slowMarker = marker;
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

    async embed(text, kind, callOptions): Promise<Embedding> {
      embedCalls.push({ text, kind, options: callOptions });
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
      if (slowMarker !== undefined && prompt.includes(slowMarker)) {
        // The real client's wrapping of an AbortSignal.timeout — indistinguishable
        // from an unreachable service by code alone (ollama/client.ts).
        throw new StrataError("OLLAMA_UNAVAILABLE", "fake ollama: generate timed out");
      }

      switch (generateMode) {
        case "unavailable":
          throw new StrataError("OLLAMA_UNAVAILABLE", "fake ollama: generate unreachable");
        case "notPulled":
          // Shaped exactly like the real client's non-2xx branch: the `status` in
          // details is what tells "never answered" from "answered badly" (DD-045).
          throw new StrataError("OLLAMA_BAD_RESPONSE", "fake ollama: answered 404", {
            details: { path: "/api/generate", status: 404 },
          });
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
 * Reproducible, and nothing more. The directions are pseudorandom, so cosine
 * between any two of these vectors sits at 0 ± 1/√768 regardless of how similar the
 * texts are — there is no semantic relationship to exploit. Any test about semantic
 * *ordering* must use `FakeStoreOptions.semanticRanking` instead of expecting
 * related texts to rank together.
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
