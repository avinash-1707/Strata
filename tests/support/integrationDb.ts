import type { Config } from "../../src/config/env.js";
import { loadConfig } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/types.js";
import { createRecordingLogger } from "./recordingLogger.js";

/**
 * The env var `scripts/integration.sh` sets. Its absence means no containers, and
 * every container-backed suite skips itself rather than failing on a machine that
 * is just running `pnpm check` (DD-030: the stack exists only during that script).
 */
export const PG_URL = process.env["STRATA_TEST_PG_URL"];
export const REDIS_URL = process.env["STRATA_TEST_REDIS_URL"];

/** A real Config whose non-Postgres values are placeholders no integration test dials. */
export function integrationConfig(postgresUrl: string): Config {
  return loadConfig({
    POSTGRES_URL: postgresUrl,
    REDIS_URL: REDIS_URL ?? "redis://127.0.0.1:1",
    OLLAMA_URL: "http://127.0.0.1:1",
    EMBEDDING_MODEL: "nomic-embed-text",
    INSTRUCT_MODEL: "qwen2.5:3b-instruct",
  });
}

/** Connects, applies migrations, and hands back a ready `Db`. Caller closes it. */
export async function connectMigrated(postgresUrl: string): Promise<Db> {
  const db = createDb(integrationConfig(postgresUrl), createRecordingLogger());
  await migrate(db);
  return db;
}

/** Empties the corpus between tests. Self-FK only, so no cascade is needed. */
export async function truncateMemories(db: Db): Promise<void> {
  await db.query("truncate table memories");
}
