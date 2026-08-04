import { describe, expect, it } from "vitest";

import { MAX_CONTENT_LENGTH, MAX_TAGS_PER_CALL } from "../../src/contracts/common.js";
import { forgetInputSchema } from "../../src/contracts/forget.js";
import {
  DEFAULT_RECALL_K,
  MAX_RECALL_K,
  recallInputSchema,
  recallOutputSchema,
} from "../../src/contracts/recall.js";
import { rememberInputSchema, rememberOutputSchema } from "../../src/contracts/remember.js";
import {
  DEFAULT_TAG_LIMIT,
  searchByTagInputSchema,
} from "../../src/contracts/searchByTag.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("remember input", () => {
  it("accepts the minimum: content alone", () => {
    expect(rememberInputSchema.parse({ content: "a fact" })).toEqual({ content: "a fact" });
  });

  it("rejects empty content", () => {
    expect(rememberInputSchema.safeParse({ content: "" }).success).toBe(false);
  });

  it("rejects content past the tsvector-safe bound", () => {
    const tooLong = { content: "x".repeat(MAX_CONTENT_LENGTH + 1) };
    expect(rememberInputSchema.safeParse(tooLong).success).toBe(false);
    expect(rememberInputSchema.safeParse({ content: "x".repeat(MAX_CONTENT_LENGTH) }).success).toBe(
      true,
    );
  });

  it("rejects more tags than can discriminate", () => {
    const tags = Array.from({ length: MAX_TAGS_PER_CALL + 1 }, (_u, i) => `t${String(i)}`);
    expect(rememberInputSchema.safeParse({ content: "c", tags }).success).toBe(false);
  });

  /* Control characters corrupt a tsvector, and a caller who can smuggle a delimiter
     into a cache-key part can make two distinct queries hash alike. */
  it.each([
    ["a null byte", "\u0000"],
    ["a newline", "\n"],
    ["an escape", "\u001b"],
  ])("rejects %s in session_id", (_label, char) => {
    const input = { content: "c", session_id: `s${char}1` };
    expect(rememberInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a control character in a tag", () => {
    expect(rememberInputSchema.safeParse({ content: "c", tags: ["ok\u0000"] }).success).toBe(false);
  });

  it("rejects an empty tag", () => {
    expect(rememberInputSchema.safeParse({ content: "c", tags: [""] }).success).toBe(false);
  });
});

describe("remember output", () => {
  it("requires a uuid and a known status", () => {
    const valid = { id: UUID, summary: "s", tags: ["a"], status: "raw" };
    expect(rememberOutputSchema.parse(valid)).toEqual(valid);
    expect(rememberOutputSchema.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
    expect(rememberOutputSchema.safeParse({ ...valid, status: "pending" }).success).toBe(false);
  });
});

describe("recall input", () => {
  /* The defaults are part of the contract. If they lived only in the tool, the HTTP
     surface would apply different ones. */
  it("applies k and synthesize defaults at the boundary", () => {
    expect(recallInputSchema.parse({ query: "why" })).toEqual({
      query: "why",
      k: DEFAULT_RECALL_K,
      synthesize: true,
    });
  });

  it("keeps an explicit k and synthesize", () => {
    const parsed = recallInputSchema.parse({ query: "why", k: 3, synthesize: false });
    expect(parsed).toMatchObject({ k: 3, synthesize: false });
  });

  it("rejects k past the synthesis-context bound", () => {
    expect(recallInputSchema.safeParse({ query: "q", k: MAX_RECALL_K + 1 }).success).toBe(false);
    expect(recallInputSchema.safeParse({ query: "q", k: MAX_RECALL_K }).success).toBe(true);
  });

  it.each([[0], [-1], [1.5]])("rejects k = %s", (k) => {
    expect(recallInputSchema.safeParse({ query: "q", k }).success).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(recallInputSchema.safeParse({ query: "" }).success).toBe(false);
  });
});

describe("recall output", () => {
  it("treats similarity as optional, since a lexical-only hit has none", () => {
    const lexicalOnly = { results: [{ id: UUID, summary: "s", tags: [], score: 0.5 }] };
    expect(recallOutputSchema.parse(lexicalOnly)).toEqual(lexicalOnly);
  });

  it("accepts a fused hit carrying a cosine", () => {
    const fused = { results: [{ id: UUID, summary: "s", tags: [], score: 0.5, similarity: 0.82 }] };
    expect(recallOutputSchema.parse(fused).results[0]?.similarity).toBe(0.82);
  });

  it("accepts zero results — empty is success, not an error", () => {
    expect(recallOutputSchema.parse({ results: [] })).toEqual({ results: [] });
  });

  it("treats answer as optional, since synthesis may be off or may have failed", () => {
    expect(recallOutputSchema.safeParse({ results: [] }).success).toBe(true);
    expect(recallOutputSchema.safeParse({ answer: "because", results: [] }).success).toBe(true);
  });
});

describe("search_by_tag input", () => {
  it("defaults to OR matching and a page limit", () => {
    expect(searchByTagInputSchema.parse({ tags: ["db"] })).toEqual({
      tags: ["db"],
      match: "any",
      limit: DEFAULT_TAG_LIMIT,
    });
  });

  /* `tags @> '{}'` is true for every row, so an empty array under match:"all" would
     dump the corpus. Closed here rather than in the store. */
  it("requires at least one tag", () => {
    expect(searchByTagInputSchema.safeParse({ tags: [] }).success).toBe(false);
    expect(searchByTagInputSchema.safeParse({ tags: [], match: "all" }).success).toBe(false);
  });

  it("rejects an unknown match mode", () => {
    expect(searchByTagInputSchema.safeParse({ tags: ["a"], match: "some" }).success).toBe(false);
  });
});

describe("forget input", () => {
  it("requires a uuid, so a malformed id fails before reaching the store", () => {
    expect(forgetInputSchema.parse({ id: UUID })).toEqual({ id: UUID });
    for (const id of ["", "123", "not-a-uuid", `${UUID}x`]) {
      expect(forgetInputSchema.safeParse({ id }).success).toBe(false);
    }
  });
});
