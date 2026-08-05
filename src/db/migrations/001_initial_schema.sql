-- 001_initial_schema.sql — the whole schema, in one migration (DD-013).
--
-- Every column DD-005, DD-009, DD-011, DD-012 and DD-020 need ships here. Adding
-- any of them later forces a rewrite of tools already built against their absence.
-- Forward-only: there is no down migration, and no schema.sql.
--
-- The migration runner owns `schema_migrations` and must create it *before* applying
-- this file — bootstrapping it here would leave the runner unable to tell whether 001
-- had already run.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table memories (
  id                uuid primary key default gen_random_uuid(),
  summary           text not null,
  raw_content       text,
  content_hash      text not null,                    -- DD-020, exact-dup idempotency
  status            text not null default 'raw',      -- DD-005: 'raw' | 'compressed'
  embedding         vector(768),                      -- DD-005: nullable
  needs_embedding   boolean not null default true,    -- DD-005: repair-pass queue
  embedding_model   text,                             -- DD-009: provenance
  summary_tsv       tsvector generated always as (    -- DD-004: summary + truncated raw
                      to_tsvector('english',
                        coalesce(summary, '') || ' ' ||
                        coalesce(left(raw_content, 50000), ''))
                    ) stored,
  tags              text[] not null default '{}',
  session_id        text,
  importance        smallint not null default 3,
  recall_count      integer not null default 0,       -- DD-011
  compaction_depth  smallint not null default 0,      -- DD-012
  -- `restrict`, stated rather than left to the default, because the alternative is
  -- actively wrong: `on delete set null` would clear superseded_by on a merge's inputs
  -- when the merged row is purged, making them live again and resurrecting content the
  -- merge replaced. A purge must deal with the inputs first (DD-012, DD-039).
  superseded_by     uuid references memories(id) on delete restrict,
  deleted_at        timestamptz,                      -- DD-012: soft delete
  created_at        timestamptz not null default now(),
  last_recalled_at  timestamptz,

  enhancement_attempts smallint not null default 0,   -- DD-041: starvation guard
  last_attempt_at      timestamptz,

  -- DD-040. A third status value would read as "not raw" and silently skip
  -- enhancement; adding this later would mean validating existing rows first.
  constraint memories_status_check check (status in ('raw', 'compressed'))
);

create table meta (                                   -- DD-008: prefix convention, etc.
  key    text primary key,
  value  text not null
);

create index memories_embedding_idx on memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128);                -- DD-017
create index memories_tsv_idx      on memories using gin (summary_tsv);
create index memories_tags_idx     on memories using gin (tags);
create index memories_session_idx  on memories (session_id);
create index memories_hash_idx     on memories (content_hash);
create index memories_live_idx     on memories (created_at desc)
  where superseded_by is null and deleted_at is null;  -- DD-012: live-row reads

-- The repair backlog's own index. memories_live_idx can supply the ordering by
-- scanning backwards, but the planner then filters row by row — and the steady state
-- is a large corpus with an almost-empty backlog, so every repair tick would scan most
-- of the live index to find nothing.
create index memories_backlog_idx on memories (created_at)
  where (status = 'raw' or needs_embedding)
    and superseded_by is null and deleted_at is null;

-- DD-032 item 11. Without this, DD-020's idempotency would be a fake-only property:
-- real Postgres would accept a double insert as two live rows. Partial, not total,
-- so content that was forgotten can be remembered again.
create unique index memories_hash_live_idx on memories (content_hash)
  where superseded_by is null and deleted_at is null;

-- DD-032 item 7: every read selects from this view, so DD-012's filter is
-- structural rather than repeated per query.
--
-- Columns are named, not `select *`: Postgres expands `*` at creation time, so a
-- later migration adding a column would leave the view silently missing it.
create view live_memories as
  select
    id,
    summary,
    raw_content,
    content_hash,
    status,
    embedding,
    needs_embedding,
    embedding_model,
    summary_tsv,
    tags,
    session_id,
    importance,
    recall_count,
    compaction_depth,
    superseded_by,
    deleted_at,
    created_at,
    last_recalled_at,
    enhancement_attempts,
    last_attempt_at
  from memories
  where superseded_by is null and deleted_at is null;
