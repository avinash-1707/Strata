import * as z from "zod";

import { StrataError } from "../errors.js";

/**
 * Even with schema-constrained generation (DD-006) this is a trust boundary. A 3B
 * model will eventually emit fenced, prose-wrapped, truncated, or wrong-keyed
 * JSON. Failure is never fatal to a write — `remember` leaves the row at
 * `status: 'raw'` and the repair pass retries (DD-005) — so this module's job is
 * to fail *deterministically*, making that decision always well-defined.
 */

/**
 * Bounded because an unbounded response flows into a tsvector that errors above
 * ~1MB (DD-004). Truncated rather than rejected: raw content is retained, so a
 * clipped summary is recoverable, whereas discarding wastes the model call.
 */
const MAX_SUMMARY_LENGTH = 8_000;

export const compressionResultSchema = z.object({
  summary: z
    .string()
    .min(1, "summary must not be empty")
    .transform((value) =>
      value.length > MAX_SUMMARY_LENGTH ? value.slice(0, MAX_SUMMARY_LENGTH) : value,
    ),
  // Lenient on tags, strict on summary: a model omitting tags still produced the
  // valuable half, and the caller merges these with caller-supplied tags anyway.
  suggested_tags: z.array(z.string()).default([]),
});

export type CompressionResult = z.infer<typeof compressionResultSchema>;

/** Derived from the Zod schema so constraint and validation cannot drift (DD-006). */
export function compressionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(compressionResultSchema, { io: "input" });
}

/**
 * Balanced-brace scanning rather than a regex or first-`{`-to-last-`}`: a regex
 * cannot match nesting, first-to-last spans two objects when the model emits
 * prose containing braces, and truncated output must yield no match at all.
 * String contents are skipped so a brace inside a summary cannot unbalance it.
 */
export function extractJsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    // charAt, not [i]: returns string rather than string | undefined, so this
    // stays clean under noUncheckedIndexedAccess without an assertion.
    const char = text.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          found.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return found;
}

/**
 * Tries every balanced object and returns the first that parses *and* validates,
 * which tolerates a model narrating before answering even when the narration
 * itself contains braces.
 *
 * @throws StrataError `OLLAMA_BAD_RESPONSE` when nothing usable is present.
 */
export function parseCompressionResult(raw: string): CompressionResult {
  const candidates = extractJsonObjects(raw);

  if (candidates.length === 0) {
    throw new StrataError(
      "OLLAMA_BAD_RESPONSE",
      "Compression response contained no complete JSON object",
      { details: { responseLength: raw.length } },
    );
  }

  let lastIssue: string | undefined;

  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      lastIssue = "candidate was brace-balanced but not valid JSON";
      continue;
    }

    const result = compressionResultSchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
    lastIssue = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }

  throw new StrataError(
    "OLLAMA_BAD_RESPONSE",
    `Compression response did not match the expected schema (${lastIssue ?? "unknown reason"})`,
    { details: { candidateCount: candidates.length } },
  );
}
