/**
 * The Postgres seam. Deliberately *not* part of `ToolDeps`: a generic
 * `query(sql, params)` cannot be faked without writing a SQL interpreter, so it
 * is unusable as the injected boundary. `MemoryStore` is that boundary instead,
 * and this interface is an implementation detail of `src/store/pg/*` (DD-032).
 *
 * Enforced by lint: only `src/store/pg/**` may import this module.
 */
export interface Queryable {
  query<R extends Row>(sql: string, params?: readonly unknown[]): Promise<readonly R[]>;
}

/** A database row. `unknown` values force validation or explicit typing at use. */
export type Row = Record<string, unknown>;

export interface Db extends Queryable {
  /**
   * Runs `fn` inside a single transaction on one pooled connection, committing on
   * resolve and rolling back on throw. Transaction scope must never leak into the
   * `MemoryStore` contract — it exists here because DD-017's `hnsw.ef_search`
   * has to be set with session-local scope on the same connection as the query.
   */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;

  /**
   * Runs `fn` on one pooled connection **without** a transaction, for the one thing
   * a transaction cannot do: hold session-scoped state across minutes of work that
   * is not database work. Only `pg_try_advisory_lock` needs this (DD-045) — an
   * advisory lock lives with its session, and the repair pass it guards spends most
   * of its time inside Ollama, where an open transaction would sit idle holding a
   * snapshot. Anything needing atomicity uses `withTransaction`.
   *
   * **The connection is destroyed rather than pooled if `fn` throws.** Session state
   * is exactly what a pool must not leak, and a failed `fn` cannot prove it cleaned
   * up after itself.
   */
  withConnection<T>(fn: (conn: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
