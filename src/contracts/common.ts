import * as z from "zod";

/**
 * Field schemas and bounds shared by more than one tool contract.
 *
 * Zod is the single source of truth for every wire type: the MCP SDK derives its
 * JSON Schema from these and validates before a handler runs, and the HTTP surface
 * parses with the same schema. TypeScript types are inferred, never hand-written
 * alongside — two definitions of one contract is how the two surfaces drift, and the
 * one that drifts is whichever validates less.
 *
 * Field names are `snake_case` because they are public API and cross the wire exactly
 * as written; the `camelCase` convention stops at this boundary.
 */

/**
 * Rejects C0/C1 control characters. Two reasons: they corrupt a `tsvector`, and a
 * caller who can put a delimiter inside a cache-key part can make two distinct
 * queries hash alike. The key builder length-prefixes for the same reason — this is
 * the other half of that fix.
 */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

function plainText(max: number, label: string): z.ZodString {
  return z
    .string()
    .max(max)
    .regex(NO_CONTROL_CHARS, `${label} must not contain control characters`);
}

/**
 * Bounded well below the ~1MB `tsvector` ceiling, and far above any plausible single
 * memory. A caller sending more than this is pasting a file, not recording a fact.
 */
export const MAX_CONTENT_LENGTH = 100_000;

/** Matches the normalization cap in `src/tags.ts`. */
export const MAX_TAG_LENGTH = 48;

/**
 * Past a handful, tags stop discriminating and `search_by_tag` returns everything.
 * Higher than `src/tags.ts`'s post-normalization cap because duplicates and rejects
 * are removed after parsing.
 */
export const MAX_TAGS_PER_CALL = 24;

export const memoryIdSchema = z.uuid();

export const tagsSchema = z
  .array(plainText(MAX_TAG_LENGTH, "a tag").min(1))
  .max(MAX_TAGS_PER_CALL);

/** Opaque to Strata — an agent's own conversation identifier (DD-018). */
export const sessionIdSchema = plainText(200, "session_id").min(1);

/** DD-005: `raw` is durably stored but not yet compressed. */
export const memoryStatusSchema = z.enum(["raw", "compressed"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

/** A stored memory as any read path returns it. */
export const memorySummaryShape = {
  id: memoryIdSchema,
  summary: z.string(),
  tags: z.array(z.string()),
} as const;
