import { describe, expect, it } from "vitest";

import type { RecallKey } from "./types.js";
import { composeRecallKey, normalizeQuery } from "./key.js";

const base: RecallKey = { query: "how does auth work", k: 8, synthesize: true };

describe("normalizeQuery", () => {
  it.each([
    ["  how does auth work  ", "how does auth work"],
    ["How Does Auth Work", "how does auth work"],
    ["how   does\tauth\nwork", "how does auth work"],
  ])("collapses %j", (input, expected) => {
    expect(normalizeQuery(input)).toBe(expected);
  });

  it("leaves an already-canonical query untouched", () => {
    expect(normalizeQuery("how does auth work")).toBe("how does auth work");
  });

  it("maps a whitespace-only query to the empty string", () => {
    expect(normalizeQuery("   \n\t ")).toBe("");
  });
});

describe("composeRecallKey", () => {
  it("puts the corpus version in the prefix, not the hash", () => {
    expect(composeRecallKey(7, base)).toMatch(/^recall:v7:[0-9a-f]{64}$/);
  });

  it("is stable for the same inputs", () => {
    expect(composeRecallKey(1, base)).toBe(composeRecallKey(1, { ...base }));
  });

  it("shares an entry across trivially different queries", () => {
    expect(composeRecallKey(1, { ...base, query: "  How Does   Auth Work " })).toBe(
      composeRecallKey(1, base),
    );
  });

  /* Each of these was a real defect before DD-010: a differing parameter that did
     not change the key served a wrong-shaped answer from cache. */
  it("changes with the corpus version, so a forget cannot be served stale", () => {
    expect(composeRecallKey(2, base)).not.toBe(composeRecallKey(1, base));
  });

  it("changes with k, so k=8 cannot collide with k=50", () => {
    expect(composeRecallKey(1, { ...base, k: 50 })).not.toBe(composeRecallKey(1, base));
  });

  it("changes with synthesize, so synthesize:false cannot be served an answer", () => {
    expect(composeRecallKey(1, { ...base, synthesize: false })).not.toBe(
      composeRecallKey(1, base),
    );
  });

  it("changes with sessionId", () => {
    expect(composeRecallKey(1, { ...base, sessionId: "s1" })).not.toBe(
      composeRecallKey(1, base),
    );
    expect(composeRecallKey(1, { ...base, sessionId: "s2" })).not.toBe(
      composeRecallKey(1, { ...base, sessionId: "s1" }),
    );
  });

  it("distinguishes tuples that a naive separator would merge", () => {
    const a = composeRecallKey(1, { query: "q", k: 1, synthesize: true, sessionId: "2" });
    const b = composeRecallKey(1, { query: "q", k: 12, synthesize: true });
    expect(a).not.toBe(b);
  });

  it("does not leak the query text into the key", () => {
    const key = composeRecallKey(1, { ...base, query: "my secret project codename" });
    expect(key).not.toContain("secret");
    expect(key).not.toContain("codename");
  });
});
