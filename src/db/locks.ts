import { describeUnknown, StrataError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Db } from "./types.js";

/**
 * Distinct from `MIGRATION_LOCK_ID`: "STRR", for repair. Two locks that shared an
 * id would make a boot-time migration and a repair pass exclude each other.
 */
const REPAIR_LOCK_ID = 0x53_54_52_52;

/**
 * Runs `fn` only if no other process is already running it, and returns `undefined`
 * if one is (DD-045).
 *
 * The HTTP daemon is one process, so the common case is now a redeploy overlapping the
 * outgoing container, or a second deployment against the same database; under the
 * retained stdio transport it is one process per client, where N sessions ran N passes
 * over the same backlog. Either way the cost is the same: duplicated CPU-bound model
 * work, and several attempts charged per row against a cap of five.
 *
 * `try`, not the blocking form: a process that arrives during someone else's pass
 * should skip its turn, not queue behind minutes of generation and then repeat it.
 */
export async function withRepairLock<T>(
  db: Db,
  log: Logger,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return db.withConnection(async (conn) => {
    const rows = await conn.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1) as acquired",
      [REPAIR_LOCK_ID],
    );
    if (rows[0]?.acquired !== true) {
      return undefined;
    }

    let result: T;
    try {
      result = await fn();
    } catch (error: unknown) {
      /* Deliberately not unlocking here: `withConnection` discards a connection whose
         body threw, and Postgres releases a session's advisory locks when the session
         ends. Issuing another query on a connection that just failed could throw again
         and bury the error the caller actually needs. */
      log.debug(
        { error: describeUnknown(error) },
        "repair pass failed while holding the lock; releasing with the connection",
      );
      throw error;
    }

    // If this throws, the connection is discarded and the lock goes with it.
    const unlocked = await conn.query<{ released: boolean }>(
      "select pg_advisory_unlock($1) as released",
      [REPAIR_LOCK_ID],
    );
    if (unlocked[0]?.released !== true) {
      /* Should be unreachable — this session acquired it. If it ever happens the
         connection is holding a lock nothing will release, and returning it to the
         pool would block every other process for the life of this one. Throwing
         hands it to `withConnection`, which destroys it. */
      throw new StrataError("DB_QUERY_FAILED", "the repair lock could not be released", {
        publicMessage: "the repair lock could not be released",
      });
    }
    return result;
  });
}
