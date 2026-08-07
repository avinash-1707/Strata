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

/** The SQLSTATE, if the caught value carries one. It names a *class* of failure
 *  (23505, 40001…) and holds no query text, so it is safe in details — unlike the
 *  driver message, which embeds statements and parameter values. */
function sqlStateOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function run<R extends Row>(
  client: pg.Pool | pg.PoolClient,
  sql: string,
  params?: readonly unknown[],
): Promise<readonly R[]> {
  try {
    const result = await client.query<R>(sql, params === undefined ? undefined : [...params]);
    // A multi-statement string (simple protocol) resolves to an array of results
    // with no single rows list; migration files are the one caller that does this.
    if (Array.isArray(result)) {
      return [];
    }
    return result.rows;
  } catch (cause) {
    // wrapError keeps the driver text in `cause`/stderr only: it embeds statements
    // and parameter values, which must never reach a surface (DD-032 item 14).
    const sqlState = sqlStateOf(cause);
    throw wrapError(
      "DB_QUERY_FAILED",
      "database query failed",
      cause,
      sqlState === undefined ? undefined : { sqlState },
    );
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

  // Idempotent: shutdown paths (normal, boot failure) may both reach close(),
  // and pool.end() throws on a second call.
  let closed = false;

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

    async withConnection<T>(fn: (conn: Queryable) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (cause) {
        throw wrapError("DB_QUERY_FAILED", "could not acquire a database connection", cause);
      }

      try {
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        client.release();
        return result;
      } catch (cause) {
        // release(true) evicts it from the pool. Whatever session state fn was
        // holding — an advisory lock, a SET — dies with the connection, which is the
        // only guarantee available once fn has failed partway through.
        client.release(true);
        throw cause;
      }
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await pool.end();
      } catch (cause) {
        throw wrapError("DB_QUERY_FAILED", "failed to close the database pool", cause);
      }
    },
  };
}
