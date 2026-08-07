import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db, Row } from "../../src/db/types.js";
import { tagSearchSql } from "../../src/store/pg/tags.js";
import { PG_URL, connectMigrated, truncateMemories } from "../support/integrationDb.js";

/**
 * Phase 10: "tag queries use the GIN index (`explain`: no sequential scan)".
 *
 * The trap in this criterion is that it is trivially satisfiable. `set
 * enable_seqscan = off` makes "no sequential scan" true by construction and proves
 * nothing, and on a ten-row table the planner is *right* to scan sequentially — so
 * a small-corpus assertion would fail against perfectly good code. The only honest
 * form is a corpus big enough that the index is genuinely the cheaper plan, with
 * statistics collected, and the planner left alone to choose.
 */

/** Big enough, with a rare tag, that a sequential scan is the expensive plan. */
const BULK_ROWS = 5_000;

/** The tag the assertions look for: on 5 of 5000 rows, i.e. 0.1% selective. */
const RARE_TAG = "needle";

const SETUP_TIMEOUT_MS = 60_000;

/** `explain (format text)` names its one column exactly this. */
interface PlanRow extends Row {
  readonly "QUERY PLAN": string;
}

if (PG_URL === undefined) {
  describe.skip("tag search uses the GIN index", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  let db: Db;

  beforeAll(async () => {
    db = await connectMigrated(url);
    await truncateMemories(db);
    await db.query(
      `insert into memories (summary, content_hash, tags, status, needs_embedding)
       select
         'bulk row ' || i,
         md5('bulk' || i::text),
         case when i % 1000 = 0 then array['common', $1::text] else array['common'] end,
         'compressed',
         false
       from generate_series(1, $2::int) as i`,
      [RARE_TAG, BULK_ROWS],
    );
    // Without statistics the planner works from defaults and its choice says nothing
    // about the data.
    await db.query("analyze memories");
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await truncateMemories(db);
    await db.close();
  });

  async function planFor(match: "any" | "all"): Promise<string> {
    const rows = await db.query<PlanRow>(`explain (format text) ${tagSearchSql(match)}`, [
      [RARE_TAG],
      20,
    ]);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  describe("tag search uses the GIN index (DD-018)", () => {
    it.each(["any", "all"] as const)("plans %s-match through memories_tags_idx", async (match) => {
      const plan = await planFor(match);

      expect(plan).toContain("memories_tags_idx");
      // The criterion as written. Named separately from the index assertion because
      // they fail for different reasons: a missing index, versus a plan that uses the
      // index and then still scans.
      expect(plan).not.toContain("Seq Scan");
    });
  });
}
