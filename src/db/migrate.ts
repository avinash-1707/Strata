import { readdir, readFile } from "node:fs/promises";

import { StrataError } from "../errors.js";
import type { Db } from "./types.js";

/**
 * Applied on boot, and the runner owns `schema_migrations` — migration 001 cannot
 * bootstrap it, or the runner could not tell whether 001 had already run (DD-013).
 * Boot-time application rather than initdb scripts, because the pgvector image only
 * runs `docker-entrypoint-initdb.d` on an empty data volume.
 */
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

const MIGRATION_FILE = /^\d{3}_[\w-]+\.sql$/u;

/**
 * Pure planning, separated so the ordering rules are unit-testable without a
 * database. Forward-only (DD-013) means the applied history must be exactly a
 * prefix of the available files: anything else — a recorded migration whose file
 * is gone, or a new file sorting *before* an applied one — is corruption that
 * no amount of applying can fix, and the server must refuse to boot on it.
 */
export function planMigrations(
  entries: readonly string[],
  applied: readonly string[],
): readonly string[] {
  const files = entries.filter((name) => name.endsWith(".sql"));

  const invalid = files.filter((name) => !MIGRATION_FILE.test(name));
  if (invalid.length > 0) {
    // Ignoring a misnamed file would silently skip its schema forever.
    throw new StrataError(
      "DB_QUERY_FAILED",
      `migration files must match NNN_name.sql: ${invalid.join(", ")}`,
    );
  }

  const ordered = [...files].sort();

  const prefixes = new Set<string>();
  for (const name of ordered) {
    // `\d{3}` is anchored by MIGRATION_FILE, so slice(0, 3) is the version number.
    const prefix = name.slice(0, 3);
    if (prefixes.has(prefix)) {
      throw new StrataError(
        "DB_QUERY_FAILED",
        `two migrations share version ${prefix}; their order would be ambiguous`,
      );
    }
    prefixes.add(prefix);
  }

  const history = [...applied].sort();
  for (const [index, name] of history.entries()) {
    if (ordered[index] !== name) {
      throw new StrataError(
        "DB_QUERY_FAILED",
        `schema_migrations does not match the migration files: applied '${name}' ` +
          `is not migration ${String(index + 1)} on disk`,
      );
    }
  }

  return ordered.slice(history.length);
}

/**
 * Serializes concurrent boots. Under the HTTP daemon that means a redeploy overlapping
 * the outgoing process, or a second deployment against the same database; under the
 * retained stdio transport it means one process per client, where two instances
 * migrating the same empty database in the same second is routine. Without the lock,
 * the loser dies on a DDL conflict and boots no further.
 * Arbitrary but stable; must never be reused for another Strata lock.
 */
const MIGRATION_LOCK_ID = 0x53_54_52_41; // "STRA"

/**
 * Applies every pending migration inside one advisory-locked transaction, each
 * file together with its `schema_migrations` row — so a half-applied run rolls
 * back whole and the next boot retries it, and a concurrent boot waits on the
 * lock, then re-reads the history and no-ops. Returns the filenames applied,
 * oldest first.
 */
export async function migrate(db: Db, dir: URL = MIGRATIONS_DIR): Promise<readonly string[]> {
  const entries = await readdir(dir);

  return db.withTransaction(async (tx) => {
    // xact-scoped: released on commit and rollback alike, so a failed migration
    // cannot leave the lock held.
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    // The client's 30s statement ceiling is sized for queries; an index build in
    // a later migration is allowed to be slow, and failing it here would make
    // the server unbootable on every retry.
    await tx.query("set local statement_timeout = 0");

    await tx.query(
      `create table if not exists schema_migrations (
         version    text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const applied = await tx.query<{ version: string }>(
      "select version from schema_migrations",
    );
    const pending = planMigrations(
      entries,
      applied.map((row) => row.version),
    );

    for (const name of pending) {
      const sql = await readFile(new URL(name, dir), "utf8");
      await tx.query(sql);
      await tx.query("insert into schema_migrations (version) values ($1)", [name]);
    }

    return pending;
  });
}
