import { describe, expect, it } from "vitest";

import { isStrataError } from "../errors.js";
import { assertEmbeddingDimensions, EMBEDDING_DIMENSIONS } from "./embedding.js";

function vector(length: number, fill = 0.1): number[] {
  return Array.from({ length }, () => fill);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isStrataError(error) ? error.code : "NOT_A_STRATA_ERROR";
  }
  return "NO_THROW";
}

describe("assertEmbeddingDimensions", () => {
  it("returns the vector unchanged at the expected width", () => {
    const input = vector(EMBEDDING_DIMENSIONS);
    expect(assertEmbeddingDimensions(input, "nomic-embed-text")).toBe(input);
  });

  it.each([[0], [1], [EMBEDDING_DIMENSIONS - 1], [EMBEDDING_DIMENSIONS + 1], [1536]])(
    "raises EMBEDDING_DIM_MISMATCH at width %i",
    (length) => {
      expect(codeOf(() => assertEmbeddingDimensions(vector(length), "m"))).toBe(
        "EMBEDDING_DIM_MISMATCH",
      );
    },
  );

  it("names both widths in the message so the wrong model is identifiable", () => {
    try {
      assertEmbeddingDimensions(vector(1536), "mxbai-embed-large");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isStrataError(error)).toBe(true);
      if (!isStrataError(error)) return;
      expect(error.message).toContain("1536");
      expect(error.message).toContain(String(EMBEDDING_DIMENSIONS));
      expect(error.details).toMatchObject({
        model: "mxbai-embed-large",
        expected: EMBEDDING_DIMENSIONS,
        actual: 1536,
      });
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s, which pgvector would refuse on insert", (_label, bad) => {
    const input = vector(EMBEDDING_DIMENSIONS);
    input[500] = bad;
    expect(codeOf(() => assertEmbeddingDimensions(input, "nomic-embed-text"))).toBe(
      "EMBEDDING_DIM_MISMATCH",
    );
  });

  it("reports the index of the first non-finite component", () => {
    const input = vector(EMBEDDING_DIMENSIONS);
    input[7] = Number.NaN;
    input[9] = Number.NaN;
    try {
      assertEmbeddingDimensions(input, "nomic-embed-text");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isStrataError(error)) throw error;
      expect(error.details).toMatchObject({ index: 7 });
    }
  });

  it("accepts a zero vector, which is valid output even if useless", () => {
    expect(() => assertEmbeddingDimensions(vector(EMBEDDING_DIMENSIONS, 0), "m")).not.toThrow();
  });
});
