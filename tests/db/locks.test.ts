import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../../src/db/client.js";
import { withRepairLock } from "../../src/db/locks.js";
import type { Db } from "../../src/db/types.js";
import { PG_URL, integrationConfig } from "../support/integrationDb.js";
import { createRecordingLogger } from "../support/recordingLogger.js";

/**
 * Two `Db` instances stand in for two server processes: stdio MCP starts one per
 * client, and they share a database (DD-045). Nothing here can be faked — the whole
 * question is what Postgres does with two sessions.
 */
if (PG_URL === undefined) {
  describe.skip("the repair lock", () => {
    it("runs only under scripts/integration.sh (STRATA_TEST_PG_URL unset)", () => undefined);
  });
} else {
  const url = PG_URL;
  const log = createRecordingLogger();
  let first: Db;
  let second: Db;

  beforeAll(() => {
    first = createDb(integrationConfig(url), log);
    second = createDb(integrationConfig(url), log);
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  /** Resolves once `held` is running, and again only when the test lets it finish. */
  function gate(): { readonly entered: Promise<void>; enter: () => void } {
    let enter = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    return { entered, enter };
  }

  describe("the repair lock (DD-045)", () => {
    it("lets one holder run and turns the other away rather than queueing it", async () => {
      const running = gate();
      const finish = gate();

      const held = withRepairLock(first, log, async () => {
        running.enter();
        await finish.entered;
        return "first";
      });
      await running.entered;

      // undefined, not a wait: a second process should skip its turn, not repeat
      // minutes of CPU-bound generation the holder is already doing.
      await expect(withRepairLock(second, log, () => Promise.resolve("second"))).resolves.toBe(
        undefined,
      );

      finish.enter();
      await expect(held).resolves.toBe("first");
    });

    it("frees the lock when the pass finishes", async () => {
      await expect(withRepairLock(first, log, () => Promise.resolve("a"))).resolves.toBe("a");

      await expect(withRepairLock(second, log, () => Promise.resolve("b"))).resolves.toBe("b");
    });

    /* The failure that would be invisible: a pass that throws while holding the lock
       must not leave repair wedged for the life of the process. */
    it("frees the lock when the pass throws", async () => {
      await expect(
        withRepairLock(first, log, () => Promise.reject(new Error("pass exploded"))),
      ).rejects.toThrow("pass exploded");

      await expect(withRepairLock(second, log, () => Promise.resolve("b"))).resolves.toBe("b");
    });

    /* A discarded connection releases its locks, but the pool must not be drained by
       the failure path either — each failed pass evicting a connection is fine only
       because the pool refills. */
    it("keeps working after repeated failures", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          withRepairLock(first, log, () => Promise.reject(new Error("again"))),
        ).rejects.toThrow("again");
      }

      await expect(withRepairLock(first, log, () => Promise.resolve("ok"))).resolves.toBe("ok");
    });
  });
}
