import * as z from "zod";

/**
 * Long enough for a correlation id or short label, short enough that the field
 * cannot be used to smuggle content into a diagnostic.
 */
export const MAX_ECHO_LENGTH = 200;

export const healthInputShape = {
  /** Echoed back verbatim, so a caller can correlate a response with its request. */
  echo: z.string().max(MAX_ECHO_LENGTH).optional(),
} as const;

export const healthInputSchema = z.object(healthInputShape);

export type HealthRequest = z.input<typeof healthInputSchema>;
export type HealthInput = z.infer<typeof healthInputSchema>;

export const healthOutputShape = {
  /** Null when Redis is unreachable, since the cache is not load-bearing. */
  corpus_version: z.number().int().nullable(),
  cache: z.enum(["up", "down"]),
  compaction_enabled: z.boolean(),
  echo: z.string().optional(),
} as const;

export const healthOutputSchema = z.object(healthOutputShape);
export type HealthOutput = z.infer<typeof healthOutputSchema>;
