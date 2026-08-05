import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS } from "../../src/ollama/embedding.js";

/**
 * Migration 001 is not applied until Phase 4, so this reads the SQL as text. It is
 * not a substitute for running it — it pins the structural requirements that DD-013
 * says cannot be gained later without rewriting built tools, and that a review would
 * otherwise have to catch by eye every time the file changes.
 */
const SQL = readFileSync(
  fileURLToPath(new URL("../../src/db/migrations/001_initial_schema.sql", import.meta.url)),
  "utf8",
);

/** Every column architecture § Data model specifies, plus DD-032's three additions. */
const REQUIRED_COLUMNS = [
  "id",
  "summary",
  "raw_content",
  "content_hash",
  "status",
  "embedding",
  "needs_embedding",
  "embedding_model",
  "summary_tsv",
  "tags",
  "session_id",
  "importance",
  "recall_count",
  "compaction_depth",
  "superseded_by",
  "deleted_at",
  "created_at",
  "last_recalled_at",
  "enhancement_attempts",
  "last_attempt_at",
] as const;

function block(start: string, end: string): string {
  const from = SQL.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
  const to = SQL.indexOf(end, from);
  expect(to, `end of ${start} not found`).toBeGreaterThan(from);
  return SQL.slice(from, to);
}

describe("migration 001: the memories table", () => {
  const table = block("create table memories", ");");

  it.each(REQUIRED_COLUMNS)("declares %s", (column) => {
    // Anchored to a line start so `summary` cannot be satisfied by `summary_tsv`.
    expect(table).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
  });

  it("declares the embedding at the width the client asserts", () => {
    expect(table).toContain(`vector(${String(EMBEDDING_DIMENSIONS)})`);
  });

  it("leaves the embedding nullable, so a raw row can still be inserted (DD-005)", () => {
    expect(table).not.toMatch(/embedding\s+vector\(\d+\)\s+not null/);
  });

  it("defaults status to raw and constrains it to the two known values (DD-040)", () => {
    expect(table).toMatch(/status\s+text not null default 'raw'/);
    expect(table).toContain("check (status in ('raw', 'compressed'))");
  });

  it("generates summary_tsv with the same text search config the query side uses (DD-014)", () => {
    expect(table).toContain("generated always as");
    expect(table).toContain("to_tsvector('english'");
    // The left() guard is what keeps a large paste from hitting the ~1MB tsvector
    // ceiling and failing the insert outright (DD-004).
    expect(table).toMatch(/left\(raw_content, \d+\)/);
  });
});

describe("migration 001: indexes DD-013 requires up front", () => {
  it.each([
    ["memories_embedding_idx", /using hnsw \(embedding vector_cosine_ops\)/],
    ["memories_tsv_idx", /using gin \(summary_tsv\)/],
    ["memories_tags_idx", /using gin \(tags\)/],
    ["memories_session_idx", /\(session_id\)/],
    ["memories_hash_idx", /\(content_hash\)/],
  ] as const)("creates %s", (name, shape) => {
    expect(SQL).toContain(name);
    expect(SQL).toMatch(shape);
  });

  it("keeps the live-row index partial (DD-012)", () => {
    expect(SQL).toMatch(
      /create index memories_live_idx[\s\S]*?where superseded_by is null and deleted_at is null/,
    );
  });

  /* DD-032 item 11. Without it, DD-020's idempotency is a fake-only property: real
     Postgres would accept a double insert as two live rows. */
  it("enforces content_hash uniqueness over live rows only", () => {
    expect(SQL).toMatch(
      /create unique index memories_hash_live_idx on memories \(content_hash\)\s*\n\s*where superseded_by is null and deleted_at is null/,
    );
  });
});

describe("migration 001: the live_memories view (DD-032 item 7)", () => {
  const view = block("create view live_memories", ";");

  it("filters exactly the rows DD-012 defines as live", () => {
    expect(view).toContain("where superseded_by is null and deleted_at is null");
  });

  /* Postgres expands `select *` at creation time, so a view written that way silently
     stops carrying columns a later migration adds. Naming them is what makes this
     assertion possible at all. */
  it("does not use select *", () => {
    expect(view).not.toMatch(/select\s+\*/);
  });

  /* The trap this closes: add a column to `memories` in migration 002, forget the
     view, and every read through it is missing the column with no error anywhere. */
  it("carries every column of the base table", () => {
    for (const column of REQUIRED_COLUMNS) {
      expect(view, `live_memories is missing ${column}`).toMatch(
        new RegExp(`^\\s+${column},?$`, "m"),
      );
    }
  });
});

describe("migration 001: extensions", () => {
  it.each(["vector", "pgcrypto"] as const)("creates %s if absent", (extension) => {
    expect(SQL).toContain(`create extension if not exists ${extension}`);
  });
});
