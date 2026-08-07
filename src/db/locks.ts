import { describeUnknown } from "../errors.js";
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
 * stdio MCP means one server process *per client*, so N open sessions used to run N
 * repair passes over the same backlog — duplicating CPU-bound model work and
 * charging several attempts per row against a cap of five. `try`, not the blocking
 * form: a process that arrives during someone else's pass should skip its turn, not
 * queue behind minutes of generation and then repeat it.
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
    await conn.query("select pg_advisory_unlock($1)", [REPAIR_LOCK_ID]);
    return result;
  });
}
