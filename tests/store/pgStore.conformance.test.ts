import { afterAll, beforeAll, describe, it } from "vitest";

import type { Db } from "../../src/db/types.js";
import { createPgStore } from "../../src/store/pg/index.js";
import { PG_URL, connectMigrated, truncateMemories } from "../support/integrationDb.js";
import { describeMemoryStore } from "./conformance.js";

/**
 * The same 45 assertions the fake passes, against real Postgres (DD-032 item 10).
 * Where the two disagree, the fake is wrong — fix the fake, never this suite.
 */
if (PG_URL === undefined) {
  describe.skip("postgres store: MemoryStore conformance", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  let db: Db;

  beforeAll(async () => {
    db = await connectMigrated(url);
  });

  afterAll(async () => {
    await db.close();
  });

  describeMemoryStore("postgres store", async () => {
    await truncateMemories(db);
    return { store: createPgStore(db) };
  });
}
