import { describe, expect, it } from "vitest";

import { planMigrations } from "../../src/db/migrate.js";
import { isStrataError } from "../../src/errors.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isStrataError(error) ? error.code : "not-a-strata-error";
  }
}

describe("planMigrations: the forward-only plan (DD-013)", () => {
  it("applies everything on an empty database, oldest first", () => {
    expect(planMigrations(["002_b.sql", "001_a.sql"], [])).toEqual(["001_a.sql", "002_b.sql"]);
  });

  it("no-ops when every file is applied", () => {
    expect(planMigrations(["001_a.sql"], ["001_a.sql"])).toEqual([]);
  });

  it("returns only the files past the applied prefix", () => {
    expect(planMigrations(["001_a.sql", "002_b.sql", "003_c.sql"], ["001_a.sql"])).toEqual([
      "002_b.sql",
      "003_c.sql",
    ]);
  });

  it("ignores non-sql directory entries", () => {
    expect(planMigrations(["001_a.sql", "README.md"], [])).toEqual(["001_a.sql"]);
  });

  it("refuses a .sql file that does not match NNN_name.sql", () => {
    // Silently skipping a typoed migration would drop its schema forever.
    expect(codeOf(() => planMigrations(["01_a.sql"], []))).toBe("DB_QUERY_FAILED");
    expect(codeOf(() => planMigrations(["initial.sql"], []))).toBe("DB_QUERY_FAILED");
  });

  it("refuses two files sharing a version number", () => {
    expect(codeOf(() => planMigrations(["001_a.sql", "001_b.sql"], []))).toBe("DB_QUERY_FAILED");
  });

  it("refuses an applied migration whose file is gone", () => {
    expect(codeOf(() => planMigrations(["002_b.sql"], ["001_a.sql"]))).toBe("DB_QUERY_FAILED");
  });

  it("refuses a new file that sorts before an applied one", () => {
    // Forward-only: inserting 001 under an already-applied 002 cannot be replayed.
    expect(codeOf(() => planMigrations(["001_a.sql", "002_b.sql"], ["002_b.sql"]))).toBe(
      "DB_QUERY_FAILED",
    );
  });
});
