import { describe, expect, it } from "vitest";

import { normalizeTag, normalizeTags } from "../src/tags.js";

describe("normalizeTag", () => {
  it("lowercases and trims", () => {
    expect(normalizeTag("  Auth  ")).toBe("auth");
    expect(normalizeTag("POSTGRES")).toBe("postgres");
  });

  it("converges spacing and hyphenation onto one form", () => {
    // The whole point: an exact-match index must not split these.
    expect(normalizeTag("connection pooling")).toBe("connection-pooling");
    expect(normalizeTag("connection-pooling")).toBe("connection-pooling");
    expect(normalizeTag("Connection   Pooling")).toBe("connection-pooling");
  });

  it("strips decoration models like to add", () => {
    expect(normalizeTag("#auth")).toBe("auth");
    expect(normalizeTag("auth,")).toBe("auth");
    expect(normalizeTag('"auth"')).toBe("auth");
    expect(normalizeTag("auth!")).toBe("auth");
  });

  it("keeps digits and underscores", () => {
    expect(normalizeTag("pg16")).toBe("pg16");
    expect(normalizeTag("session_id")).toBe("session_id");
  });

  it("keeps non-Latin scripts", () => {
    expect(normalizeTag("café")).toBe("café");
    expect(normalizeTag("日本語")).toBe("日本語");
  });

  it("collapses and trims stray hyphens", () => {
    expect(normalizeTag("--auth--")).toBe("auth");
    expect(normalizeTag("a  --  b")).toBe("a-b");
  });

  it("rejects values that would pollute the index", () => {
    expect(normalizeTag("")).toBeUndefined();
    expect(normalizeTag("   ")).toBeUndefined();
    expect(normalizeTag("!!!")).toBeUndefined();
    expect(normalizeTag("-")).toBeUndefined();
  });

  it("rejects a sentence masquerading as a tag", () => {
    expect(normalizeTag("x".repeat(49))).toBeUndefined();
    expect(normalizeTag("x".repeat(48))).toBe("x".repeat(48));
  });
});

describe("normalizeTags", () => {
  it("merges sources and deduplicates after normalization", () => {
    expect(normalizeTags(["Auth", "auth "], ["AUTH", "db"])).toEqual(["auth", "db"]);
  });

  it("skips undefined sources", () => {
    expect(normalizeTags(undefined, ["a"], undefined)).toEqual(["a"]);
  });

  it("returns empty for no usable input", () => {
    expect(normalizeTags()).toEqual([]);
    expect(normalizeTags([], undefined)).toEqual([]);
    expect(normalizeTags(["", "!!!"])).toEqual([]);
  });

  it("drops unusable tags without dropping the rest", () => {
    expect(normalizeTags(["auth", "", "db"])).toEqual(["auth", "db"]);
  });

  it("caps the tag count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${String(i)}`);
    expect(normalizeTags(many)).toHaveLength(12);
  });

  it("prefers caller tags over model suggestions when capping", () => {
    // Caller tags are passed first, so truncation must not discard them.
    const caller = Array.from({ length: 12 }, (_, i) => `caller${String(i)}`);
    const suggested = ["model-tag"];
    expect(normalizeTags(caller, suggested)).not.toContain("model-tag");
  });

  it("preserves first-seen order", () => {
    expect(normalizeTags(["zebra", "apple"], ["mango"])).toEqual([
      "zebra",
      "apple",
      "mango",
    ]);
  });
});
