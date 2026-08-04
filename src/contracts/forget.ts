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
