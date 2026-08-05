import { describe, expect, it } from "vitest";

import { DEFAULT_TAG_LIMIT } from "../../src/contracts/searchByTag.js";
import { isStrataError } from "../../src/errors.js";
import { searchByTag } from "../../src/tools/searchByTag.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import type { SeedMemory } from "../fakes/fakeStore.js";

const ROWS: readonly SeedMemory[] = [
  { id: "a", summary: "pool exhaustion", tags: ["postgres", "timeout"], createdAt: new Date(1) },
  { id: "b", summary: "chose pgvector", tags: ["postgres", "vectors"], createdAt: new Date(2) },
  { id: "c", summary: "redis cache", tags: ["redis"], createdAt: new Date(3) },
];

function query(overrides: Partial<Parameters<typeof searchByTag>[0]> = {}): Parameters<
  typeof searchByTag
>[0] {
  return { tags: ["postgres"], match: "any", limit: DEFAULT_TAG_LIMIT, ...overrides };
}

describe("search_by_tag", () => {
  it("matches any tag by default", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["postgres", "redis"] }), deps);

    expect(found.results.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("requires every tag under match: all", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["postgres", "vectors"], match: "all" }), deps);

    expect(found.results.map((row) => row.id)).toEqual(["b"]);
  });

  it("returns newest first", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["postgres", "redis"] }), deps);

    expect(found.results.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  it("honors the limit", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["postgres", "redis"], limit: 1 }), deps);

    expect(found.results).toHaveLength(1);
  });

  it("serializes created_at as an ISO 8601 string", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query(), deps);

    expect(found.results[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is a success with an empty array when no memory carries the tag", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["kubernetes"] }), deps);

    expect(found.results).toEqual([]);
  });

  /* `remember` stores normalized tags, so searching with raw ones would silently
     match nothing — the failure mode is a wrong answer, not an error. */
  it("normalizes the search tags the same way remember does", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["  POSTGRES "] }), deps);

    expect(found.results.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });

  /* `tags @> '{}'` is true for every row, so an all-match over an empty array would
     return the entire corpus. Rejecting is the only safe answer. */
  it("rejects input whose tags all normalize away, rather than matching everything", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    await expect(searchByTag(query({ tags: ["###", "!!!"], match: "all" }), deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "INVALID_INPUT",
    );
  });

  it("keeps the tags that do normalize when only some are junk", async () => {
    const deps = createFakeDeps({ store: { rows: ROWS } });

    const found = await searchByTag(query({ tags: ["###", "postgres"] }), deps);

    expect(found.results.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });

  /* normalizeTags caps at 12, which is a *write-side* budget. The contract accepts 24,
     and dropping search terms under match: "all" does not narrow the query — it
     returns rows satisfying only a prefix of it. */
  it("does not drop search tags at the write-side cap of 12", async () => {
    const many = Array.from({ length: 20 }, (_unused, index) => `tag-${String(index)}`);
    const deps = createFakeDeps({
      store: {
        rows: [
          { id: "all", summary: "s", tags: many },
          { id: "prefix", summary: "s", tags: many.slice(0, 12) },
        ],
      },
    });

    const found = await searchByTag(query({ tags: many, match: "all" }), deps);

    expect(found.results.map((row) => row.id)).toEqual(["all"]);
  });

  it("never returns a non-live row (DD-012)", async () => {
    const deps = createFakeDeps({
      store: {
        rows: [
          { id: "live", summary: "s", tags: ["postgres"] },
          { id: "deleted", summary: "s", tags: ["postgres"], deletedAt: new Date() },
          { id: "merged", summary: "s", tags: ["postgres"], supersededBy: "live" },
        ],
      },
    });

    const found = await searchByTag(query(), deps);

    expect(found.results.map((row) => row.id)).toEqual(["live"]);
  });

  it("fails when Postgres is down", async () => {
    const deps = createFakeDeps({ store: { down: true } });

    await expect(searchByTag(query(), deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
  });

  /* "unaffected" in the failure-mode table: no cache, no model, no version bump. */
  it("is unaffected by Redis and Ollama being down", async () => {
    const deps = createFakeDeps({
      store: { rows: ROWS },
      cache: { down: true },
      ollama: { embed: "unavailable", generate: "unavailable" },
    });

    const found = await searchByTag(query(), deps);

    expect(found.results.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(deps.cache.calls).toEqual([]);
    expect(deps.ollama.embedCalls).toEqual([]);
    expect(deps.ollama.generateCalls).toEqual([]);
  });
});
