import * as z from "zod";

import { memorySummaryShape, sessionIdSchema } from "./common.js";

/** Eight fits an agent's context budget without crowding out its actual task. */
export const DEFAULT_RECALL_K = 8;

/** Beyond this the synthesis prompt stops fitting a small model's context. */
export const MAX_RECALL_K = 50;

/** Long enough for a real question, short enough to embed in one pass. */
export const MAX_QUERY_LENGTH = 2_000;

export const recallInputShape = {
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  k: z.number().int().positive().max(MAX_RECALL_K).default(DEFAULT_RECALL_K),
  synthesize: z.boolean().default(true),
  /** DD-018: optional scope filter. */
  session_id: sessionIdSchema.optional(),
} as const;

export const recallInputSchema = z.object(recallInputShape);

export type RecallRequest = z.input<typeof recallInputSchema>;
export type RecallInput = z.infer<typeof recallInputSchema>;

export const recallResultSchema = z.object({
  ...memorySummaryShape,
  /** RRF score. Ordinal only — never threshold it or compare across queries (DD-016). */
  score: z.number(),
  /**
   * Raw cosine, present only when the semantic ranker contributed this hit. A
   * lexical-only hit has no cosine, and inventing one would make an absent signal
   * look measured (DD-033).
   */
  similarity: z.number().optional(),
});

export type RecallResult = z.infer<typeof recallResultSchema>;

export const recallOutputShape = {
  /** Present iff `synthesize` was true and synthesis succeeded (DD-005). */
  answer: z.string().optional(),
  results: z.array(recallResultSchema),
} as const;

export const recallOutputSchema = z.object(recallOutputShape);
export type RecallOutput = z.infer<typeof recallOutputSchema>;
