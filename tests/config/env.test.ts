import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { isStrataError } from "../../src/errors.js";

const valid = {
  POSTGRES_URL: "postgres://strata:strata@localhost:5432/strata",
  REDIS_URL: "redis://localhost:6379",
  OLLAMA_URL: "http://localhost:11434",
  EMBEDDING_MODEL: "nomic-embed-text",
  INSTRUCT_MODEL: "qwen2.5:3b-instruct",
} satisfies NodeJS.ProcessEnv;

/** Assert loadConfig rejects and that the message names the offending key. */
function expectRejection(env: NodeJS.ProcessEnv, key: string): void {
  try {
    loadConfig(env);
    throw new Error(`expected loadConfig to reject for ${key}`);
  } catch (error) {
    if (!isStrataError(error)) {
      throw error;
    }
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain(key);
    expect(error.details?.keys).toContain(key);
  }
}

describe("loadConfig — accepts valid input", () => {
  it("returns a config for a complete environment", () => {
    const config = loadConfig(valid);
    expect(config.POSTGRES_URL).toBe(valid.POSTGRES_URL);
    expect(config.EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("applies defaults for optional settings", () => {
    const config = loadConfig(valid);
    expect(config.OLLAMA_TIMEOUT_MS).toBeGreaterThan(0);
    // Compaction is destructive, so it must default off (DD-012).
    expect(config.COMPACTION_ENABLED).toBe(false);
    expect(config.MCP_AUTH_TOKEN).toBeUndefined();
  });

  it("freezes the result", () => {
    const config = loadConfig(valid);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("ignores unrelated environment variables", () => {
    expect(() => loadConfig({ ...valid, HOME: "/root", PATH: "/bin" })).not.toThrow();
  });
});

describe("loadConfig — names the offending key", () => {
  it("rejects a missing required variable", () => {
    const { POSTGRES_URL: _omitted, ...withoutPostgres } = valid;
    expectRejection(withoutPostgres, "POSTGRES_URL");
  });

  it("rejects an empty required variable", () => {
    expectRejection({ ...valid, EMBEDDING_MODEL: "" }, "EMBEDDING_MODEL");
  });

  it("rejects a non-absolute Ollama URL", () => {
    // Bare z.url() accepts this, reading "localhost:" as the scheme.
    expectRejection({ ...valid, OLLAMA_URL: "localhost:11434" }, "OLLAMA_URL");
    expectRejection({ ...valid, OLLAMA_URL: "ollama:11434" }, "OLLAMA_URL");
    expectRejection({ ...valid, OLLAMA_URL: "not a url" }, "OLLAMA_URL");
  });

  it("rejects a non-http Ollama URL", () => {
    expectRejection({ ...valid, OLLAMA_URL: "ftp://ollama:11434" }, "OLLAMA_URL");
  });

  it("rejects a non-numeric timeout", () => {
    expectRejection({ ...valid, OLLAMA_TIMEOUT_MS: "soon" }, "OLLAMA_TIMEOUT_MS");
  });

  it("rejects a zero or negative timeout", () => {
    expectRejection({ ...valid, OLLAMA_TIMEOUT_MS: "0" }, "OLLAMA_TIMEOUT_MS");
    expectRejection({ ...valid, OLLAMA_TIMEOUT_MS: "-1" }, "OLLAMA_TIMEOUT_MS");
  });

  it("rejects a short auth token", () => {
    expectRejection({ ...valid, MCP_AUTH_TOKEN: "tooshort" }, "MCP_AUTH_TOKEN");
  });

  it("reports every offending key at once, not just the first", () => {
    try {
      loadConfig({ OLLAMA_URL: "nope" });
      throw new Error("expected rejection");
    } catch (error) {
      if (!isStrataError(error)) {
        throw error;
      }
      for (const key of [
        "POSTGRES_URL",
        "REDIS_URL",
        "OLLAMA_URL",
        "EMBEDDING_MODEL",
        "INSTRUCT_MODEL",
      ]) {
        expect(error.message).toContain(key);
      }
    }
  });
});

describe("loadConfig — coercion", () => {
  it("accepts a numeric timeout as a string", () => {
    expect(loadConfig({ ...valid, OLLAMA_TIMEOUT_MS: "90000" }).OLLAMA_TIMEOUT_MS).toBe(
      90_000,
    );
  });

  it("accepts both boolean spellings for COMPACTION_ENABLED", () => {
    expect(loadConfig({ ...valid, COMPACTION_ENABLED: "true" }).COMPACTION_ENABLED).toBe(
      true,
    );
    expect(loadConfig({ ...valid, COMPACTION_ENABLED: "1" }).COMPACTION_ENABLED).toBe(
      true,
    );
    expect(loadConfig({ ...valid, COMPACTION_ENABLED: "false" }).COMPACTION_ENABLED).toBe(
      false,
    );
  });

  it("rejects an ambiguous boolean rather than guessing", () => {
    expectRejection({ ...valid, COMPACTION_ENABLED: "yes" }, "COMPACTION_ENABLED");
  });

  it("accepts a sufficiently long auth token", () => {
    const token = "a".repeat(32);
    expect(loadConfig({ ...valid, MCP_AUTH_TOKEN: token }).MCP_AUTH_TOKEN).toBe(token);
  });

  /* Compose's env_file turns a bare `MCP_AUTH_TOKEN=` into "" rather than omitting
     it. Treating that as a too-short token refuses to boot over a setting that is
     inert under stdio (DD-026). */
  it("reads an empty auth token as absent rather than too short", () => {
    expect(loadConfig({ ...valid, MCP_AUTH_TOKEN: "" }).MCP_AUTH_TOKEN).toBeUndefined();
  });
});
