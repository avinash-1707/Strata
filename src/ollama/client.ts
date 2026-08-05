import * as z from "zod";

import type { Config } from "../config/env.js";
import { StrataError, wrapError } from "../errors.js";
import { assertEmbeddingDimensions } from "./embedding.js";
import type { EmbeddingKind, GenerateOptions, ModelCallOptions, Ollama } from "./types.js";

/**
 * The real model client. Written in Phase 4 but not verifiable here — no model
 * weights ever run on this machine (DD-027) — so every model-behavior assumption
 * below carries an UNVERIFIED marker for Phase 5 to confirm or fix (DD-029).
 */

/**
 * DD-008: task prefixes break biencoder symmetry for the nomic family. Applied
 * here and nowhere else, keyed off model family — prefixing a non-nomic model
 * corrupts its embeddings exactly as badly as omitting the prefix corrupts nomic's.
 *
 * UNVERIFIED (DD-029): Phase 5 must check whether Ollama's packaged Modelfile
 * already injects a prefix — if it does, doing it again here is its own bug, and
 * DD-008 gets amended rather than implemented (DD-022).
 */
const TASK_PREFIXES: Record<EmbeddingKind, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

function isNomicFamily(model: string): boolean {
  return model.toLowerCase().startsWith("nomic-embed");
}

// UNVERIFIED (DD-029): assumes the current /api/embed endpoint and its response
// shape { model, embeddings: [[...]] }; older Ollama builds only ship /api/embeddings.
const embedResponseSchema = z.object({
  model: z.string().optional(),
  embeddings: z.array(z.array(z.number())).min(1),
});

// UNVERIFIED (DD-029): assumes non-streaming /api/generate answers with
// { response: "..." } once stream:false is set.
const generateResponseSchema = z.object({
  response: z.string(),
});

export function createOllamaClient(config: Config, fetchFn: typeof fetch = fetch): Ollama {
  async function post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(new URL(path, config.OLLAMA_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // A stuck CPU-bound generation must never hang a tool call (DD-028).
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw wrapError("OLLAMA_UNAVAILABLE", "ollama is unreachable", cause, {
        path,
        timeoutMs,
      });
    }

    if (!response.ok) {
      // Reachable but unusable is a different problem from unreachable: this one
      // is fixed on the Ollama side (missing model, bad request), not the network.
      throw new StrataError("OLLAMA_BAD_RESPONSE", `ollama answered ${String(response.status)}`, {
        details: { path, status: response.status },
        publicMessage: "the model service returned an error",
      });
    }

    try {
      return await response.json();
    } catch (cause) {
      throw wrapError("OLLAMA_BAD_RESPONSE", "ollama answered non-JSON", cause, { path });
    }
  }

  return {
    async embed(text, kind, options?: ModelCallOptions) {
      const model = config.EMBEDDING_MODEL;
      const prefixed = isNomicFamily(model) ? `${TASK_PREFIXES[kind]}${text}` : text;

      const payload = await post(
        "/api/embed",
        { model, input: prefixed },
        options?.timeoutMs ?? config.OLLAMA_TIMEOUT_MS,
      );

      const parsed = embedResponseSchema.safeParse(payload);
      const vector = parsed.success ? parsed.data.embeddings[0] : undefined;
      if (vector === undefined) {
        throw new StrataError("OLLAMA_BAD_RESPONSE", "ollama returned no embedding", {
          details: { model },
          publicMessage: "the embedding service returned an unusable response",
        });
      }

      return {
        vector: assertEmbeddingDimensions(vector, model),
        // The producing model travels with the vector (DD-009); the request model
        // is the fallback when the response omits its own.
        model: parsed.success ? (parsed.data.model ?? model) : model,
      };
    },

    async generate(prompt, options?: GenerateOptions) {
      const payload = await post(
        "/api/generate",
        {
          model: config.INSTRUCT_MODEL,
          prompt,
          stream: false,
          // Structured outputs take a JSON Schema, never format:"json" (DD-006).
          ...(options?.format === undefined ? {} : { format: options.format }),
          // Zero unless a caller asks otherwise: determinism matters more than
          // creativity everywhere this client is used (DD-006).
          options: { temperature: options?.temperature ?? 0 },
        },
        options?.timeoutMs ?? config.OLLAMA_TIMEOUT_MS,
      );

      const parsed = generateResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new StrataError("OLLAMA_BAD_RESPONSE", "ollama returned no response field", {
          details: { model: config.INSTRUCT_MODEL },
          publicMessage: "the model service returned an unusable response",
        });
      }
      return parsed.data.response;
    },
  };
}
