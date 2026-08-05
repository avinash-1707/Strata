import pg from "pg";

import type { Config } from "../config/env.js";
import { describeUnknown, wrapError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Db, Queryable, Row } from "./types.js";

/** Bounds waiting for a pooled connection, so an exhausted pool fails a tool call
 *  instead of queueing it forever. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Server-side ceiling per statement. Generous because migration 001 builds an HNSW
 * index and a first `create extension vector` can be slow on a cold container; a
 * normal query finishing anywhere near this is already a defect.
 */
const STATEMENT_TIMEOUT_MS = 30_000;

async function run<R extends Row>(
  client: pg.Pool | pg.PoolClient,
  sql: string,
  params?: readonly unknown[],
): Promise<readonly R[]> {
  try {
    const result = await client.query<R>(sql, params === undefined ? undefined : [...params]);
    return result.rows;
  } catch (cause) {
    // wrapError keeps the driver text in `cause`/stderr only: it embeds statements
    // and parameter values, which must never reach a surface (DD-032 item 14).
    throw wrapError("DB_QUERY_FAILED", "database query failed", cause);
  }
}

export function createDb(config: Config, log: Logger): Db {
  const pool = new pg.Pool({
    connectionString: config.POSTGRES_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });

  // An idle pooled connection can fail out-of-band (server restart, network drop).
  // Without a listener that surfaces as an uncaught exception and kills the
  // process; the pool already discards the broken connection, so logging is the
  // only work left to do.
  pool.on("error", (error) => {
    log.warn({ error: error.message }, "idle database connection errored");
  });

  return {
    query: (sql, params) => run(pool, sql, params),

    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (cause) {
        throw wrapError("DB_QUERY_FAILED", "could not acquire a database connection", cause);
      }

      try {
        await run(client, "begin");
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        await run(client, "commit");
        client.release();
        return result;
      } catch (cause) {
        try {
          await run(client, "rollback");
          client.release();
        } catch (rollbackCause) {
          // A connection whose rollback failed is in an unknown state; destroying it
          // (release(true) evicts it from the pool) is the handling. The original
          // error still propagates — it is the one the caller can act on.
          log.warn(
            { error: describeUnknown(rollbackCause) },
            "rollback failed; discarding the connection",
          );
          client.release(true);
        }
        // Passes an inner StrataError through unchanged, so a tx body keeps its code.
        throw wrapError("DB_QUERY_FAILED", "transaction failed", cause);
      }
    },

    async close() {
      try {
        await pool.end();
      } catch (cause) {
        throw wrapError("DB_QUERY_FAILED", "failed to close the database pool", cause);
      }
    },
  };
}
