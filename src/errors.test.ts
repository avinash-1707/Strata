import { describe, expect, it } from "vitest";

import {
  describeUnknown,
  isStrataError,
  StrataError,
  wrapError,
} from "./errors.js";

describe("StrataError", () => {
  it("carries the code and preserves the cause", () => {
    const cause = new Error("connection refused");
    const error = new StrataError("DB_QUERY_FAILED", "query failed", { cause });

    expect(error.code).toBe("DB_QUERY_FAILED");
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("StrataError");
    expect(error).toBeInstanceOf(Error);
  });

  it("omits cause cleanly when none is given", () => {
    const error = new StrataError("NOT_FOUND", "no such memory");
    expect(error.cause).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe("describeUnknown", () => {
  it("handles the shapes a catch block actually receives", () => {
    expect(describeUnknown(new Error("boom"))).toBe("boom");
    expect(describeUnknown("plain string throw")).toBe("plain string throw");
    expect(describeUnknown({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
    expect(describeUnknown(undefined)).toBe("undefined");
    expect(describeUnknown(null)).toBe("null");
  });

  it("never throws on a circular value", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeUnknown(circular)).not.toThrow();
  });

  it("never throws on a value with a throwing getter", () => {
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    expect(() => describeUnknown(hostile)).not.toThrow();
  });
});

describe("wrapError", () => {
  it("wraps a foreign error and keeps it as cause", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapped = wrapError("OLLAMA_UNAVAILABLE", "embed failed", cause);

    expect(wrapped.code).toBe("OLLAMA_UNAVAILABLE");
    expect(wrapped.message).toBe("embed failed: ECONNREFUSED");
    expect(wrapped.cause).toBe(cause);
  });

  it("passes an existing StrataError through unchanged", () => {
    // The innermost layer knows the most specific code; re-wrapping buries it.
    const original = new StrataError("EMBEDDING_DIM_MISMATCH", "expected 768");
    expect(wrapError("DB_QUERY_FAILED", "insert failed", original)).toBe(original);
  });

  it("attaches details when provided", () => {
    const wrapped = wrapError("DB_QUERY_FAILED", "failed", new Error("x"), {
      table: "memories",
    });
    expect(wrapped.details).toEqual({ table: "memories" });
  });
});

describe("isStrataError", () => {
  it("distinguishes StrataError from other throwables", () => {
    expect(isStrataError(new StrataError("NOT_FOUND", "x"))).toBe(true);
    expect(isStrataError(new Error("x"))).toBe(false);
    expect(isStrataError("x")).toBe(false);
    expect(isStrataError(undefined)).toBe(false);
  });
});
