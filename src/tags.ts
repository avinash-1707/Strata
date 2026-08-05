/**
 * Tags arrive from the caller of `remember` and from the model's
 * `suggested_tags`, which disagree about formatting. Without normalization
 * "Auth", "auth " and "auth" become three tags, and `search_by_tag` — an exact
 * array match, not a search — silently misses two of them.
 */

/** Long enough for "postgres-connection-pooling", short enough to reject a sentence. */
const MAX_TAG_LENGTH = 48;

/**
 * A small instruct model asked for keywords will occasionally return a dozen.
 * Past a handful they stop discriminating and `search_by_tag` returns everything.
 *
 * A **write-side** budget: it decides how many tags a memory is worth carrying. Read
 * paths must not reuse it — silently dropping search terms narrows nothing, it
 * returns rows that do not match the query that was asked.
 */
export const MAX_TAGS = 12;

/**
 * Order is preserved across sources, so caller tags (passed first) outrank
 * model-suggested ones when the cap truncates.
 */
export function normalizeTags(
  ...sources: readonly (readonly string[] | undefined)[]
): string[] {
  return normalizeTagsWithin(MAX_TAGS, ...sources);
}

/**
 * Normalization without the write-side cap. `search_by_tag` uses this because the
 * contract accepts `MAX_TAGS_PER_CALL` (24) tags and dropping any of them turns a
 * `match: "all"` query into a different, wrong query.
 */
export function normalizeTagsWithin(
  max: number,
  ...sources: readonly (readonly string[] | undefined)[]
): string[] {
  const seen = new Set<string>();

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }
    for (const raw of source) {
      const tag = normalizeTag(raw);
      if (tag !== undefined) {
        seen.add(tag);
      }
      if (seen.size >= max) {
        return [...seen];
      }
    }
  }

  return [...seen];
}

/**
 * Returns undefined rather than an empty string: a tag that survives as "" or as
 * a paragraph is worse than no tag, because it pollutes an exact-match index.
 */
export function normalizeTag(raw: string): string | undefined {
  const tag = raw
    .trim()
    .toLowerCase()
    // Hyphenate so "connection pooling" and "connection-pooling" converge.
    .replace(/\s+/g, "-")
    // Models return "#auth" and "auth," — both should land on "auth".
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
    return undefined;
  }
  return tag;
}
