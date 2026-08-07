import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COMPACTION_MIN_AGE_DAYS, COMPACTION_POLICY } from "../../src/config/budgets.js";
import type { Db } from "../../src/db/types.js";
import { createPgStore } from "../../src/store/pg/index.js";
import type { MemoryStore, NewMemory } from "../../src/store/types.js";
import { PG_URL, connectMigrated, truncateMemories } from "../support/integrationDb.js";

/**
 * The half of DD-012's eligibility rule the conformance suite cannot reach.
 *
 * Conformance may only touch the seam, and the seam has no way to write `created_at`
 * or `importance` — so it can move the age *floor* but never age a row, and it can
 * never make two rows differ in importance. Both are arranged here with SQL, which is
 * the only way to ask the question the criterion actually asks: does selection turn
 * on age and usage, and is it genuinely blind to `importance`?
 */

const LIMIT = 20;
const OLD_ENOUGH_DAYS = COMPACTION_MIN_AGE_DAYS + 10;

function newMemory(hash: string, summary: string): NewMemory {
  return { summary, rawContent: summary, contentHash: hash, tags: [], sessionId: null };
}

if (PG_URL === undefined) {
  describe.skip("compaction candidate selection against real Postgres", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  let db: Db;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await connectMigrated(url);
    store = createPgStore(db);
  }, 30_000);

  afterAll(async () => {
    await truncateMemories(db);
    await db.close();
  });

  beforeEach(async () => {
    await truncateMemories(db);
  });

  async function aged(hash: string, summary: string, days: number): Promise<string> {
    const row = await store.insertRaw(newMemory(hash, summary));
    await db.query(
      "update memories set created_at = now() - interval '1 day' * $2::double precision where id = $1",
      [row.id, days],
    );
    return row.id;
  }

  async function candidateIds(): Promise<string[]> {
    const found = await store.findCompactionCandidates(LIMIT, COMPACTION_POLICY);
    return found.map((row) => row.id);
  }

  describe("age, under the real policy", () => {
    it("offers a memory older than the floor and holds back a fresh one", async () => {
      const old = await aged("compaction-old", "an old unread note", OLD_ENOUGH_DAYS);
      const fresh = await aged("compaction-fresh", "a note from this week", 1);

      const candidates = await candidateIds();

      expect(candidates).toContain(old);
      expect(candidates).not.toContain(fresh);
    });

    it("measures age from the last recall, not the write", async () => {
      /* An arranged state, not a natural one: `touchUsage` sets `recall_count` too, so
         a real read would already be excluded by the usage clause. Arranging it in
         isolation is what proves the `greatest(...)` term is load-bearing rather than
         shadowed by `recall_count = 0`. */
      const id = await aged("compaction-reread", "written long ago, read recently", OLD_ENOUGH_DAYS);
      await db.query("update memories set last_recalled_at = now() - interval '1 day' where id = $1", [
        id,
      ]);

      await expect(candidateIds()).resolves.not.toContain(id);
    });

    /* The depth cap under the *shipped* policy, not an inverted one. Conformance can
       only move `maxDepth`, because the seam has no way to write `compaction_depth` —
       so this is the only place the production configuration is exercised against a
       row that has already been merged once (DD-012). */
    it("excludes an already-merged row under the shipped policy", async () => {
      const merged = await aged("compaction-depth-1", "the output of an earlier merge", OLD_ENOUGH_DAYS);
      const unmerged = await aged("compaction-depth-0", "never merged", OLD_ENOUGH_DAYS);
      await db.query("update memories set compaction_depth = 1 where id = $1", [merged]);

      const candidates = await candidateIds();

      expect(candidates).not.toContain(merged);
      expect(candidates).toContain(unmerged);
    });

    it("returns the coldest first, so a truncated batch is the best candidates", async () => {
      const oldest = await aged("compaction-oldest", "the oldest note", OLD_ENOUGH_DAYS + 100);
      const newer = await aged("compaction-newer", "a less old note", OLD_ENOUGH_DAYS);

      const found = await store.findCompactionCandidates(1, COMPACTION_POLICY);

      expect(found.map((row) => row.id)).toEqual([oldest]);
      expect(await candidateIds()).toEqual([oldest, newer]);
    });
  });

  /* DD-012's headline defect: the original design selected on `importance`, which no
     tool writes — so every row holds the default and the predicate hands the entire
     corpus to an unattended merge. Nothing but real SQL can even create the disagreement
     this asserts is ignored. */
  describe("importance is not a signal", () => {
    it("selects the same rows whatever importance says", async () => {
      const lowest = await aged("compaction-imp-1", "marked least important", OLD_ENOUGH_DAYS);
      const highest = await aged("compaction-imp-5", "marked most important", OLD_ENOUGH_DAYS);
      await db.query("update memories set importance = 1 where id = $1", [lowest]);
      await db.query("update memories set importance = 5 where id = $1", [highest]);

      const candidates = await candidateIds();

      expect(candidates).toContain(lowest);
      expect(candidates).toContain(highest);
    });

    it("keeps a much-recalled memory even when it is marked unimportant", async () => {
      const id = await aged("compaction-hot", "old, unimportant, and read constantly", OLD_ENOUGH_DAYS);

      /* `recall_count` is set directly rather than through `touchUsage`, which would
         also stamp `last_recalled_at = now()` and make the row young — leaving the age
         term, not the usage term, as the reason it was excluded. */
      await db.query("update memories set importance = 1, recall_count = 5 where id = $1", [id]);

      await expect(candidateIds()).resolves.not.toContain(id);
    });
  });
}
