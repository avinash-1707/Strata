import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSilentLogger, isLogLevel, LOG_LEVELS } from "./logger.js";

const PROBE = fileURLToPath(new URL("./testing/loggerProbe.ts", import.meta.url));

function runProbe(): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", PROBE], {
    encoding: "utf8",
    // A pipe, not "inherit": inheriting vitest's fds would make the assertion
    // vacuous, since the child would then share the parent's stdout.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("isLogLevel", () => {
  it("accepts every declared level", () => {
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }
  });

  it.each([["verbose"], ["INFO"], ["trace"], [""]])("rejects %j", (value) => {
    expect(isLogLevel(value)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel(30)).toBe(false);
    expect(isLogLevel({ level: "info" })).toBe(false);
  });
});

describe("createSilentLogger", () => {
  it("swallows every level without throwing", () => {
    const log = createSilentLogger();
    expect(() => {
      log.debug({}, "d");
      log.info({}, "i");
      log.warn({}, "w");
      log.error({}, "e");
    }).not.toThrow();
  });

  it("returns itself from child, so nesting cannot resurrect output", () => {
    const log = createSilentLogger();
    expect(log.child({ tool: "x" })).toBe(log);
  });
});

describe("createLogger (subprocess, real fds)", () => {
  const probe = runProbe();

  it("exits cleanly", () => {
    expect(probe.status).toBe(0);
  });

  /* The load-bearing assertion of DD-026: stdout is the MCP protocol channel, so
     a single byte of logging on fd 1 corrupts the JSON-RPC stream. */
  it("writes nothing at all to stdout", () => {
    expect(probe.stdout).toBe("");
  });

  it("writes every level to stderr", () => {
    expect(probe.stderr).toContain("probe-info");
    expect(probe.stderr).toContain("probe-debug");
    expect(probe.stderr).toContain("probe-error");
  });

  it("emits one JSON object per line", () => {
    const lines = probe.stderr.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toMatchObject({ msg: expect.any(String) });
    }
  });

  it("redacts secrets at top level and one level deep", () => {
    expect(probe.stderr).not.toContain("super-secret-token-value");
    expect(probe.stderr).not.toContain("postgres://user:pw@host/db");
    expect(probe.stderr).toContain("[redacted]");
  });

  it("keeps non-secret context", () => {
    // The full key/value, not just "probe" — every message contains that substring,
    // so asserting on it alone would pass even if the field were dropped.
    expect(probe.stderr).toContain('"tool":"probe"');
  });

  /* wrapError folds its cause into a message string, so a failed connection arrives
     as a DSN inside a value that redact's path matching cannot reach. */
  it("redacts a connection string embedded in a message string", () => {
    expect(probe.stderr).not.toContain("s3cret");
    expect(probe.stderr).not.toContain("10.0.0.4:5432");
    expect(probe.stderr).toContain("[redacted-dsn]");
  });

  it("redacts one nested inside an array", () => {
    expect(probe.stderr).not.toContain("hunter2");
  });

  it("keeps the surrounding text of a scrubbed message", () => {
    expect(probe.stderr).toContain("connect ECONNREFUSED");
  });
});
