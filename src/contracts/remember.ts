import * as z from "zod";

import {
  MAX_CONTENT_LENGTH,
  memoryIdSchema,
  memoryStatusSchema,
  sessionIdSchema,
  tagsSchema,
} from "./common.js";

/**
 * A raw shape, not a `z.object`, because `McpServer.registerTool` takes the shape and
 * derives the wire JSON Schema from it. The assembled schema below is what the HTTP
 * surface parses with, so both validate identically.
 */
export const rememberInputShape = {
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_LENGTH)
    .describe(
      "The full text worth keeping, including the reasoning behind it. Do not " +
        "pre-summarize — it is compressed for you, and detail you drop here is gone.",
    ),
  tags: tagsSchema
    .optional()
    .describe(
      "Optional topic labels for later retrieval with search_by_tag. Lowercased and " +
        "de-duplicated on write, and more may be added automatically.",
    ),
  session_id: sessionIdSchema
    .optional()
    .describe(
      "Optional. Your own conversation identifier, opaque to Strata. Pass the same " +
        "value to recall to scope a search to this conversation.",
    ),
} as const;

export const rememberInputSchema = z.object(rememberInputShape);

/** What a caller sends: optional fields still optional. */
export type RememberRequest = z.input<typeof rememberInputSchema>;

/** What a tool receives: validated, with defaults applied. */
export type RememberInput = z.infer<typeof rememberInputSchema>;

export const rememberOutputShape = {
  id: memoryIdSchema.describe("The stored memory's id. Pass it to forget."),
  summary: z
    .string()
    .describe(
      "The compressed form that will be searched. While status is 'raw' this is the " +
        "opening of your own content instead.",
    ),
  tags: z
    .array(z.string())
    .describe("The tags actually stored: yours, normalized, plus any that were suggested."),
  /** DD-005: lets a caller tell a compressed memory from a durable raw one. */
  status: memoryStatusSchema.describe(
    "'compressed' means the memory is summarized and searchable by meaning. 'raw' " +
      "means it is durably stored but compression has not run yet; it is still " +
      "retrievable by keyword, and the server retries in the background.",
  ),
} as const;

export const rememberOutputSchema = z.object(rememberOutputShape);
export type RememberOutput = z.infer<typeof rememberOutputSchema>;
