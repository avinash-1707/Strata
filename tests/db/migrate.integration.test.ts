import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/types.js";
import { PG_URL, integrationConfig } from "../support/integrationDb.js";
import { createRecordingLogger } from "../support/recordingLogger.js";

/**
 * The runner's exit criteria need a database that is *empty* — not merely
 * truncated — so this suite creates a scratch database beside the shared one and
 * drops it again, rather than trusting whatever state other files left behind.
 */
const SCRATCH_DB = "strata_migrate_scratch";

if (PG_URL === undefined) {
  describe.skip("migration runner against real Postgres", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const adminUrl = PG_URL;
  const scratchUrl = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  })();

  let admin: Db;
  let scratch: Db;

  beforeAll(async () => {
    admin = createDb(integrationConfig(adminUrl), createRecordingLogger());
    // `with (force)` so a leaked connection from a crashed earlier run cannot
    // wedge the suite.
    await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await admin.query(`create database ${SCRATCH_DB}`);
    scratch = createDb(integrationConfig(scratchUrl), createRecordingLogger());
  });

  afterAll(async () => {
    await scratch.close();
    await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await admin.close();
  });

  describe("migration runner against real Postgres (DD-013)", () => {
    it("applies 001 cleanly to an empty database, then no-ops on a second run", async () => {
      await expect(migrate(scratch)).resolves.toEqual(["001_initial_schema.sql"]);
      await expect(migrate(scratch)).resolves.toEqual([]);

      const applied = await scratch.query<{ version: string }>(
        "select version from schema_migrations order by version",
      );
      expect(applied.map((row) => row.version)).toEqual(["001_initial_schema.sql"]);
    });

    it("left a usable schema behind: the live view answers a query", async () => {
      const rows = await scratch.query<{ count: string }>(
        "select count(id) as count from live_memories",
      );
      expect(rows[0]?.count).toBe("0");
    });
  });
}
