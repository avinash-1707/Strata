import { MAX_TAGS_PER_CALL } from "../contracts/common.js";
import type { SearchByTagInput, SearchByTagOutput } from "../contracts/searchByTag.js";
import type { ToolDeps } from "../deps.js";
import { StrataError } from "../errors.js";
import { normalizeTagsWithin } from "../tags.js";

/**
 * Unaffected by Redis and Ollama: no cache, no model, no version bump. Postgres
 * failing is the only way this fails.
 */
export async function searchByTag(
  input: SearchByTagInput,
  deps: ToolDeps,
): Promise<SearchByTagOutput> {
  /* `remember` stores normalized tags, so searching with raw ones would silently match
     nothing. Capped at the contract's own limit, not at `normalizeTags`' write-side
     cap of 12: with `match: "all"` and more than 12 tags, dropping the rest returns
     rows that satisfy only a prefix of the query. */
  const tags = normalizeTagsWithin(MAX_TAGS_PER_CALL, input.tags);

  if (tags.length === 0) {
    // Not an empty result: `match: "all"` over an empty array matches every row,
    // because `tags @> '{}'` is true for all of them.
    throw new StrataError("INVALID_INPUT", "no usable tag remained after normalization", {
      publicMessage: "no usable tag remained after normalization",
      details: { supplied: input.tags.length },
    });
  }

  const rows = await deps.store.searchByTag(tags, input.match, input.limit);

  return {
    results: rows.map((row) => ({
      id: row.id,
      summary: row.summary,
      tags: [...row.tags],
      created_at: row.createdAt.toISOString(),
    })),
  };
}
