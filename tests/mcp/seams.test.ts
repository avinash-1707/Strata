import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

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
/**
 * A statement verb spanning newlines — real queries are multi-line template
 * literals, and a pattern using `.` instead of `[\s\S]` cannot match one at all,
 * which is the shape most likely to be pasted into a tool.
 */
const SQL_VERBS = [
  /\bselect\b[\s\S]*?\bfrom\s+\w/i,
  /\binsert\s+into\s+\w/i,
  /\bupdate\s+\w+\s+set\b/i,
  /\bdelete\s+from\s+\w/i,
  /\bcreate\s+(table|view|extension|(unique\s+)?index)\b/i,
  /\bon\s+conflict\b/i,
];

/**
 * A verb alone is not enough: "select the best candidate from the ranked list" is a
 * perfectly good comment, and a check that fires on prose gets deleted rather than
 * fixed. Requiring one of this schema's actual relations makes the signal specific
 * — real SQL here always names one.
 */
const SQL_RELATIONS = /\b(live_memories|memories|schema_migrations)\b/i;

function containsSql(source: string): boolean {
  return SQL_RELATIONS.test(source) && SQL_VERBS.some((pattern) => pattern.test(source));
}

/** `src/` is production-only now that tests live outside it, so no filtering. */
async function sqlOffendersIn(directory: string): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await filesUnder(join(SRC, directory))) {
    const source = await readFile(file, "utf8");
    if (containsSql(source)) {
      offenders.push(file.replace(SRC, "src/"));
    }
  }
  return offenders;
}

describe("no SQL above the store layer (DD-032, coding-standards §8)", () => {
  it("finds no SQL in the MCP surface", async () => {
    await expect(sqlOffendersIn("mcp")).resolves.toEqual([]);
  });

  it("finds no SQL in the search layer, which keeps only pure fusion", async () => {
    const offenders = await sqlOffendersIn("search");

    expect(offenders).toEqual([]);
  });

  /* Guards against the check rotting into a no-op. The multi-line case is the one
     that matters: it is how every real query is written, and the original
     `select .* from` pattern could not match it at all. */
  it.each([
    ["single line", "select id, summary from live_memories where tags && $1"],
    [
      "multi-line template literal",
      `
        select id, summary, tags, created_at
        from live_memories
        where tags && $1
        order by created_at desc
        limit $2
      `,
    ],
    ["upper case", "SELECT ID\nFROM LIVE_MEMORIES"],
    ["insert", "insert into memories (summary, content_hash)\nvalues ($1, $2)"],
    ["upsert", "insert into memories (content_hash)\nvalues ($1)\non conflict do nothing"],
    ["update", "update memories set recall_count = recall_count + 1\nwhere id = any($1)"],
    ["delete", "delete from memories\nwhere id = $1"],
    ["ddl", "create unique index memories_hash_live_idx\n  on memories (content_hash)"],
  ])("detects SQL: %s", (_label, sql) => {
    expect(containsSql(sql)).toBe(true);
  });

  /* And does not fire on ordinary prose or TypeScript, or the grep would be
     unusable and get deleted rather than fixed. */
  it.each([
    ["a comment about selection", "// select the best candidate from the ranked list"],
    ["array methods", "const ids = rows.map((row) => row.id).filter(Boolean);"],
    ["an update log line", "log.info({ count }, 'updated usage');"],
    ["prose naming the table", "// memories are stored durably before any model call"],
    ["a type referencing the domain", "const rows: MemoryRecord[] = await store.searchByTag();"],
  ])("does not fire on %s", (_label, source) => {
    expect(containsSql(source)).toBe(false);
  });
});


