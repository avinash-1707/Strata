import * as z from "zod";

import { memoryIdSchema } from "./common.js";

export const forgetInputShape = {
  id: memoryIdSchema,
} as const;

export const forgetInputSchema = z.object(forgetInputShape);

export type ForgetRequest = z.input<typeof forgetInputSchema>;
export type ForgetInput = z.infer<typeof forgetInputSchema>;

export const forgetOutputShape = {
  /** DD-018: `false` distinguishes "no such live memory" from a successful delete. */
  deleted: z.boolean(),
} as const;

export const forgetOutputSchema = z.object(forgetOutputShape);
export type ForgetOutput = z.infer<typeof forgetOutputSchema>;

/**
 * The inverse of forget (DD-039), so it lives beside it: one module owns the deletion
 * lifecycle. REST-only by default — restoring is an operator action, and every extra
 * MCP tool dilutes selection of remember and recall.
 */
export const restoreInputShape = {
  id: memoryIdSchema,
} as const;

export const restoreInputSchema = z.object(restoreInputShape);

export type RestoreRequest = z.input<typeof restoreInputSchema>;
export type RestoreInput = z.infer<typeof restoreInputSchema>;

export const restoreOutputShape = {
  /** `false` for an id that is unknown *or* was never deleted — nothing to undo. */
  restored: z.boolean(),
} as const;

export const restoreOutputSchema = z.object(restoreOutputShape);
export type RestoreOutput = z.infer<typeof restoreOutputSchema>;
