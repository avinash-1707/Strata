import * as z from "zod";

import { memoryIdSchema } from "./common.js";

export const forgetInputShape = {
  id: memoryIdSchema.describe(
    "The id of the memory to remove from future recall. Recall or search first to " +
      "confirm you have the right one — this is not reversible from here.",
  ),
} as const;

export const forgetInputSchema = z.object(forgetInputShape);

export type ForgetRequest = z.input<typeof forgetInputSchema>;
export type ForgetInput = z.infer<typeof forgetInputSchema>;

export const forgetOutputShape = {
  /** DD-018: `false` distinguishes "no such live memory" from a successful delete. */
  deleted: z
    .boolean()
    .describe(
      "False when no live memory had that id — it either never existed or was " +
        "already forgotten. Nothing was changed in that case.",
    ),
} as const;

export const forgetOutputSchema = z.object(forgetOutputShape);
export type ForgetOutput = z.infer<typeof forgetOutputSchema>;

/**
 * The inverse of forget (DD-039), so it lives beside it: one module owns the deletion
 * lifecycle. REST-only by default — restoring is an operator action, and every extra
 * MCP tool dilutes selection of remember and recall.
 */
export const restoreInputShape = {
  id: memoryIdSchema.describe("The id of a previously forgotten memory to make visible again."),
} as const;

export const restoreInputSchema = z.object(restoreInputShape);

export type RestoreRequest = z.input<typeof restoreInputSchema>;
export type RestoreInput = z.infer<typeof restoreInputSchema>;

export const restoreOutputShape = {
  /** `false` for an id that is unknown *or* was never deleted — nothing to undo. */
  restored: z
    .boolean()
    .describe(
      "False when there was nothing to undo: the id is unknown, was never forgotten, " +
        "or its content has since been stored again under a new id.",
    ),
} as const;

export const restoreOutputSchema = z.object(restoreOutputShape);
export type RestoreOutput = z.infer<typeof restoreOutputSchema>;
