import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Lint covers the import seams; this covers the one rule lint cannot express.
 * "No SQL in tool files" is a property of string literals, not of the module
 * graph, so it needs a grep — and a grep in a test is the only kind that runs.
 */
const SQL_KEYWORDS = [
  /\bselect\s+.*\bfrom\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
  /\bdelete\s+from\b/i,
  /\bcreate\s+(table|index|view|extension)\b/i,
];

describe("no SQL above the store layer (DD-032, coding-standards §8)", () => {
  it("finds no SQL in any tool file", async () => {
    const files = await filesUnder(join(SRC, "mcp"));
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith(".test.ts")) {
        continue;
      }
      const source = await readFile(file, "utf8");
      if (SQL_KEYWORDS.some((pattern) => pattern.test(source))) {
        offenders.push(file.replace(SRC, "src/"));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("finds no SQL in the search layer, which keeps only pure fusion", async () => {
    const files = await filesUnder(join(SRC, "search"));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (SQL_KEYWORDS.some((pattern) => pattern.test(source))) {
        offenders.push(file.replace(SRC, "src/"));
      }
    }

    expect(offenders).toEqual([]);
  });

  /* Guards against the check silently rotting into a no-op if the patterns are
     ever weakened. */
  it("detects SQL when it is present", () => {
    const sql = "select id, summary from live_memories where tags && $1";
    expect(SQL_KEYWORDS.some((pattern) => pattern.test(sql))).toBe(true);
  });
});

describe("ToolDeps exposes no database handle (DD-032)", () => {
  it("names the store, not a Db", async () => {
    const source = await readFile(join(SRC, "mcp", "deps.ts"), "utf8");

    expect(source).toContain("store: MemoryStore");
    // A `Db` in ToolDeps is the specific defect DD-032 corrects: it is unfakeable,
    // so its presence would make the fake-backed tool tests unbuildable.
    expect(source).not.toMatch(/^\s*readonly db\b/m);
  });
});
