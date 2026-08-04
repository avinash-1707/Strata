import { describe, expect, it } from "vitest";

import {
  describeUnknown,
  isStrataError,
  StrataError,
  publicMessageOf,
  wrapError,
} from "../src/errors.js";

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

describe("publicMessageOf", () => {
  /* A tool result is read by a model and kept in a client transcript. A wrapped
     driver error's message carries the failing statement, its parameter values —
     which are memory content — and a DSN's credentials. Only authored text may
     cross that boundary. */
  it("returns only the authored prefix of a wrapped error", () => {
    const cause = new Error(
      'insert into memories ... failed: duplicate key value "the user\'s private note"',
    );
    const wrapped = wrapError("DB_QUERY_FAILED", "could not store the memory", cause);

    expect(publicMessageOf(wrapped)).toBe("could not store the memory");
    expect(publicMessageOf(wrapped)).not.toContain("private note");
    // The full text is still available for stderr.
    expect(wrapped.message).toContain("private note");
  });

  it("redacts a connection string embedded in a cause", () => {
    const wrapped = wrapError(
      "DB_QUERY_FAILED",
      "database unreachable",
      new Error("connect ECONNREFUSED postgres://strata:s3cret@10.0.0.4:5432/strata"),
    );

    expect(publicMessageOf(wrapped)).toBe("database unreachable");
    expect(publicMessageOf(wrapped)).not.toContain("s3cret");
  });

  it("passes through a hand-authored StrataError message", () => {
    const error = new StrataError("NOT_FOUND", "no memory has that id");
    expect(publicMessageOf(error)).toBe("no memory has that id");
  });

  it("says nothing specific about an unknown throwable", () => {
    for (const value of [new Error("EACCES /etc/shadow"), "raw string", { a: 1 }, undefined]) {
      expect(publicMessageOf(value)).toBe("an unexpected internal error occurred");
    }
  });

  it("keeps the authored prefix when an existing StrataError passes through wrapError", () => {
    const inner = wrapError("OLLAMA_UNAVAILABLE", "model call failed", new Error("secret detail"));
    const outer = wrapError("DB_QUERY_FAILED", "outer", inner);

    expect(outer).toBe(inner);
    expect(publicMessageOf(outer)).toBe("model call failed");
  });
});
