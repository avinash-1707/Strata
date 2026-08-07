import * as z from "zod";

import { memorySummaryShape, sessionIdSchema } from "./common.js";

/** Eight fits an agent's context budget without crowding out its actual task. */
export const DEFAULT_RECALL_K = 8;

/** Beyond this the synthesis prompt stops fitting a small model's context. */
export const MAX_RECALL_K = 50;

/** Long enough for a real question, short enough to embed in one pass. */
export const MAX_QUERY_LENGTH = 2_000;

export const recallInputShape = {
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .describe(
      "The question to answer, written out in full. Keyword and meaning-based search " +
        "both run over it, so a sentence retrieves better than a few keywords.",
    ),
  k: z
    .number()
    .int()
    .positive()
    .max(MAX_RECALL_K)
    .default(DEFAULT_RECALL_K)
    .describe(`How many memories to return. Defaults to ${String(DEFAULT_RECALL_K)}.`),
  synthesize: z
    .boolean()
    .default(true)
    .describe(
      "Whether to also return a written answer drawn from the retrieved memories. " +
        "Set false when you only want the memories: it skips the model and is much faster.",
    ),
  /** DD-018: optional scope filter. */
  session_id: sessionIdSchema
    .optional()
    .describe(
      "Optional. Search only memories stored under this conversation identifier. " +
        "Omit it to search everything.",
    ),
} as const;

export const recallInputSchema = z.object(recallInputShape);

export type RecallRequest = z.input<typeof recallInputSchema>;
export type RecallInput = z.infer<typeof recallInputSchema>;

export const recallResultSchema = z.object({
  ...memorySummaryShape,
  /** RRF score. Ordinal only — never threshold it or compare across queries (DD-016). */
  score: z
    .number()
    .describe(
      "Ranking score only. Use it to order results; it is not a confidence, and it " +
        "cannot be compared across queries or thresholded.",
    ),
  /**
   * Raw cosine, present only when the semantic ranker contributed this hit. A
   * lexical-only hit has no cosine, and inventing one would make an absent signal
   * look measured (DD-033).
   */
  similarity: z
    .number()
    .optional()
    .describe(
      "Cosine similarity to the query, 0 to 1. Present only when this memory was " +
        "found by meaning; a keyword-only match has none.",
    ),
});

export type RecallResult = z.infer<typeof recallResultSchema>;

export const recallOutputShape = {
  /** Present iff `synthesize` was true and synthesis succeeded (DD-005). */
  answer: z
    .string()
    .optional()
    .describe(
      "An answer written from the retrieved memories and nothing else. Absent when " +
        "synthesis was not requested or was unavailable — the results still stand.",
    ),
  results: z.array(recallResultSchema).describe("The retrieved memories, best match first."),
} as const;

export const recallOutputSchema = z.object(recallOutputShape);
export type RecallOutput = z.infer<typeof recallOutputSchema>;
