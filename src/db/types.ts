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
  close(): Promise<void>;
}
