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
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  tags: tagsSchema.optional(),
  session_id: sessionIdSchema.optional(),
} as const;

export const rememberInputSchema = z.object(rememberInputShape);

/** What a caller sends: optional fields still optional. */
export type RememberRequest = z.input<typeof rememberInputSchema>;

/** What a tool receives: validated, with defaults applied. */
export type RememberInput = z.infer<typeof rememberInputSchema>;

export const rememberOutputShape = {
  id: memoryIdSchema,
  summary: z.string(),
  tags: z.array(z.string()),
  /** DD-005: lets a caller tell a compressed memory from a durable raw one. */
  status: memoryStatusSchema,
} as const;

export const rememberOutputSchema = z.object(rememberOutputShape);
export type RememberOutput = z.infer<typeof rememberOutputSchema>;
