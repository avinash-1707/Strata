import * as z from "zod";

import { memorySummaryShape, tagsSchema } from "./common.js";

/** One page of results — enough to scan, small enough to read. */
export const DEFAULT_TAG_LIMIT = 20;

export const MAX_TAG_LIMIT = 200;

export const searchByTagInputShape = {
  /**
   * At least one tag is required. `match: "all"` over an empty array would match
   * every row, because `tags @> '{}'` is true for all of them — the schema is the
   * right place to close that, not the store.
   */
  tags: tagsSchema
    .min(1)
    .describe(
      "The tags to match, at least one. This is an exact match on stored tags, not a " +
        "search — use recall for questions.",
    ),
  /** DD-018: OR by default (`tags && $1`); `"all"` uses `tags @> $1`. */
  match: z
    .enum(["any", "all"])
    .default("any")
    .describe(
      "'any' returns memories carrying at least one of the tags (the default). " +
        "'all' returns only those carrying every one.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_TAG_LIMIT)
    .default(DEFAULT_TAG_LIMIT)
    .describe(`Maximum memories to return. Defaults to ${String(DEFAULT_TAG_LIMIT)}.`),
} as const;

export const searchByTagInputSchema = z.object(searchByTagInputShape);

export type SearchByTagRequest = z.input<typeof searchByTagInputSchema>;
export type SearchByTagInput = z.infer<typeof searchByTagInputSchema>;

export const searchByTagResultSchema = z.object({
  ...memorySummaryShape,
  /** ISO 8601. Serialized at the boundary; internal types carry a Date. */
  created_at: z.iso.datetime().describe("When the memory was stored, ISO 8601."),
});

export type SearchByTagResult = z.infer<typeof searchByTagResultSchema>;

export const searchByTagOutputShape = {
  results: z.array(searchByTagResultSchema).describe("The matching memories, newest first."),
} as const;

export const searchByTagOutputSchema = z.object(searchByTagOutputShape);
export type SearchByTagOutput = z.infer<typeof searchByTagOutputSchema>;
