import { StrataError, isStrataError } from "../../errors.js";
import type { Db, Queryable, Row } from "../../db/types.js";
import type {
  CompactionPolicy,
  EnhancementRetryPolicy,
  Enhancement,
  MemoryRecord,
  NewMemory,
} from "../types.js";

/** Postgres unique_violation — the memories_hash_live_idx raising on a race. */
const UNIQUE_VIOLATION = "23505";

/**
 * The only module that names the base `memories` table: reads go through
 * `live_memories` so DD-012's filter is structural, writes land here.
 */

/**
 * Deliberately excludes `embedding` and `summary_tsv`: no read path ships 768
 * floats or a tsvector to a tool, and `MemoryRecord` has no field for either.
 */
export const MEMORY_COLUMNS = [
  "id",
  "summary",
  "raw_content",
  "content_hash",
  "status",
  "needs_embedding",
  "embedding_model",
  "tags",
  "session_id",
  "importance",
  "recall_count",
  "compaction_depth",
  "superseded_by",
  "deleted_at",
  "created_at",
  "last_recalled_at",
  "enhancement_attempts",
  "last_attempt_at",
].join(", ");

/** The wire shape of one `memories` row, exactly as `pg` type-maps it. */
export interface MemoryRow extends Row {
  readonly id: string;
  readonly summary: string;
  readonly raw_content: string | null;
  readonly content_hash: string;
  readonly status: "raw" | "compressed";
  readonly needs_embedding: boolean;
  readonly embedding_model: string | null;
  readonly tags: string[];
  readonly session_id: string | null;
  readonly importance: number;
  readonly recall_count: number;
  readonly compaction_depth: number;
  readonly superseded_by: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly last_recalled_at: Date | null;
  readonly enhancement_attempts: number;
  readonly last_attempt_at: Date | null;
}

export function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    summary: row.summary,
    rawContent: row.raw_content,
    contentHash: row.content_hash,
    status: row.status,
    needsEmbedding: row.needs_embedding,
    embeddingModel: row.embedding_model,
    tags: row.tags,
    sessionId: row.session_id,
    importance: row.importance,
    recallCount: row.recall_count,
    compactionDepth: row.compaction_depth,
    supersededBy: row.superseded_by,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    lastRecalledAt: row.last_recalled_at,
    enhancementAttempts: row.enhancement_attempts,
    lastAttemptAt: row.last_attempt_at,
  };
}

/** pgvector's input literal. Only ever built from validated 768-wide vectors. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export async function findLiveByContentHash(
  db: Queryable,
  contentHash: string,
): Promise<MemoryRecord | undefined> {
  const rows = await db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS} from live_memories where content_hash = $1`,
    [contentHash],
  );
  const row = rows[0];
  return row === undefined ? undefined : toMemoryRecord(row);
}

// Takes `Db`, not `Queryable`, on purpose: the durable insert must be its own
// autocommit statement (DD-005). A Queryable would let a future caller enroll it
// in a transaction that also holds a model call, making the durable write
// non-durable until the model answers — the exact bug DD-005 exists to prevent.
export async function insertRaw(db: Db, memory: NewMemory): Promise<MemoryRecord> {
  const rows = await db.query<MemoryRow>(
    // The conflict target names the partial unique index's predicate: two racing
    // `remember`s can both pass findLiveByContentHash, and a plain insert would
    // then raise 23505 and tell the losing caller its durable write failed (DD-020).
    `insert into memories (summary, raw_content, content_hash, tags, session_id)
     values ($1, $2, $3, $4, $5)
     on conflict (content_hash) where superseded_by is null and deleted_at is null
     do nothing
     returning ${MEMORY_COLUMNS}`,
    [memory.summary, memory.rawContent, memory.contentHash, [...memory.tags], memory.sessionId],
  );
  const row = rows[0];
  if (row !== undefined) {
    return toMemoryRecord(row);
  }
  // Lost the race: the winning row is the durable result for this content.
  const winner = await findLiveByContentHash(db, memory.contentHash);
  if (winner === undefined) {
    // The winner was deleted between the conflict and this select. Retrying could
    // loop; surfacing is correct — the caller's write genuinely did not land.
    throw new StrataError(
      "DB_QUERY_FAILED",
      "insert hit a duplicate that disappeared before it could be returned",
      { details: { contentHash: memory.contentHash } },
    );
  }
  return winner;
}

export async function applyEnhancement(
  db: Queryable,
  id: string,
  enhancement: Enhancement,
): Promise<MemoryRecord | undefined> {
  const embedding = enhancement.embedding;
  const rows = await db.query<MemoryRow>(
    // coalesce keeps an existing vector when this pass produced none: compression
    // alone must not blind semantic search to a previously embedded row (DD-005).
    // The counter reset is DD-045: this row made progress, so its failure history is
    // spent — and a still-incomplete row is charged again by its own failure path.
    `update memories set
       summary = $2,
       tags = $3,
       status = 'compressed',
       needs_embedding = $4,
       embedding = coalesce($5::vector, embedding),
       embedding_model = $6,
       enhancement_attempts = 0,
       last_attempt_at = null
     where id = $1 and superseded_by is null and deleted_at is null
     returning ${MEMORY_COLUMNS}`,
    [
      id,
      enhancement.summary,
      [...enhancement.tags],
      embedding === null,
      embedding === null ? null : vectorLiteral(embedding),
      enhancement.embeddingModel,
    ],
  );
  const row = rows[0];
  return row === undefined ? undefined : toMemoryRecord(row);
}

export async function touchUsage(db: Queryable, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db.query(
    `update memories
     set recall_count = recall_count + 1, last_recalled_at = now()
     where id = any($1::uuid[]) and superseded_by is null and deleted_at is null`,
    [[...ids]],
  );
}

export async function softDelete(db: Queryable, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update memories set deleted_at = now()
     where id = $1 and superseded_by is null and deleted_at is null
     returning id`,
    [id],
  );
  return rows.length > 0;
}

export async function restore(db: Queryable, id: string): Promise<boolean> {
  try {
    const rows = await db.query<{ id: string }>(
      // `not exists` mirrors memories_hash_live_idx: restoring under a live duplicate
      // would raise 23505, so "not restorable" is the answer, not an error (DD-039).
      // The correlated `memories.content_hash` is the row being updated.
      `update memories set deleted_at = null
       where id = $1
         and deleted_at is not null
         and superseded_by is null
         and not exists (
           select 1 from live_memories
           where live_memories.content_hash = memories.content_hash
         )
       returning id`,
      [id],
    );
    return rows.length > 0;
  } catch (error) {
    // The `not exists` check races a concurrent restore/remember of the same
    // content: the loser hits the index anyway. That is still "not restorable",
    // the answer DD-039 documents — not a 500.
    if (isStrataError(error) && error.details?.["sqlState"] === UNIQUE_VIOLATION) {
      return false;
    }
    throw error;
  }
}

export async function findEnhancementBacklog(
  db: Queryable,
  limit: number,
  policy: EnhancementRetryPolicy,
): Promise<readonly MemoryRecord[]> {
  const rows = await db.query<MemoryRow>(
    // The backoff term is server-side `now()`, never a timestamp from the app: two
    // server processes with drifting clocks would otherwise disagree about which
    // rows are claimable (DD-045).
    `select ${MEMORY_COLUMNS} from live_memories
     where (status = 'raw' or needs_embedding)
       and enhancement_attempts < $2
       and (last_attempt_at is null
            or last_attempt_at <=
               now() - interval '1 millisecond' * $3::double precision
                     * power(2, enhancement_attempts))
     order by created_at, id
     limit $1`,
    [limit, policy.maxAttempts, policy.retryBaseMs],
  );
  return rows.map(toMemoryRecord);
}

export async function findCompactionCandidates(
  db: Queryable,
  limit: number,
  policy: CompactionPolicy,
): Promise<readonly MemoryRecord[]> {
  const rows = await db.query<MemoryRow>(
    /* DD-012. `importance` appears nowhere on purpose: no tool writes it, so every
       row holds the default and a predicate over it selects the whole corpus.
       `recall_count = 0` is the usage half, and it is only trustworthy because a
       cache hit also counts (DD-011) — without that, the most-recalled memories would
       look coldest here.

       Server-side `now()`, never an app timestamp: two processes with drifting
       clocks would disagree about what is old.

       SIMPLIFIED: no index serves this. `memories_live_idx` is `created_at desc`, and
       the ordering expression is `greatest(...)`, so a run scans and sorts the live
       rows — and unlike the repair backlog, the eligible set is most of the corpus in
       steady state. Fine at DD-017's single-user scale, and it runs on a schedule with
       nobody waiting. If the corpus grows, index
       `(greatest(created_at, coalesce(last_recalled_at, created_at))) where
       recall_count = 0 and superseded_by is null and deleted_at is null`. */
    `select ${MEMORY_COLUMNS} from live_memories
     where recall_count = 0
       and compaction_depth < $3
       and greatest(created_at, coalesce(last_recalled_at, created_at))
           < now() - interval '1 day' * $2::double precision
     order by greatest(created_at, coalesce(last_recalled_at, created_at)), id
     limit $1`,
    [limit, policy.minAgeDays, policy.maxDepth],
  );
  return rows.map(toMemoryRecord);
}

export async function recordEnhancementAttempt(db: Queryable, id: string): Promise<void> {
  // No live-row filter: an attempt may be recorded against a row a concurrent
  // forget just removed, and losing the increment is worse than stamping a dead row.
  await db.query(
    `update memories
     set enhancement_attempts = enhancement_attempts + 1, last_attempt_at = now()
     where id = $1`,
    [id],
  );
}

export async function deferEnhancement(db: Queryable, id: string): Promise<void> {
  // The stamp without the increment: the row steps aside for one backoff window,
  // but keeps its record clean because the failure was not its fault (DD-045).
  await db.query("update memories set last_attempt_at = now() where id = $1", [id]);
}
