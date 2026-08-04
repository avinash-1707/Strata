# Strata: Development Context

This document is the technical source of truth for building Strata. It is written to be fed directly to a coding agent as context, so it favors exact specs over narrative explanation. Where a decision has already been made, build to that decision rather than re-deriving it.

## What is being built

An MCP server, written in TypeScript, that gives AI agents durable, compressed, semantically searchable memory. It stores memory in Postgres with pgvector, caches hot context in Redis, and uses two local models via Ollama: one for embeddings, one for compression on write and synthesis on read. Everything runs locally, no external API calls, no data leaves the host machine.

## Non-goals

Do not build multi-user support, real-time collaborative editing, or verbatim transcript storage as raw content beyond an optional audit field. This is a single-user, single-host system.

## Tech stack (exact)

- Runtime: Node.js 20+, TypeScript
- Web/MCP server framework: Hono
- Database: PostgreSQL 16+ with the `pgvector` extension
- Cache: Redis 7+
- Postgres client: `pg` (node-postgres)
- Local model runtime: Ollama, accessed over its local HTTP API at `http://localhost:11434`
- Embedding model: `nomic-embed-text` (768 dimensions)
- Instruct model: `qwen2.5:3b-instruct`, fallback to `qwen2.5:1.5b-instruct` if latency is unacceptable
- Orchestration: Docker Compose
- MCP integration: official MCP TypeScript SDK

## Proposed repository structure

```
strata/
  src/
    mcp/
      server.ts          # MCP server entrypoint, tool registration
      tools/
        remember.ts
        recall.ts
        searchByTag.ts
        forget.ts
        compact.ts
    db/
      schema.sql
      client.ts           # pg pool setup
      migrations/
    ollama/
      client.ts           # thin wrapper around Ollama HTTP API
      prompts.ts          # compression and synthesis prompt templates
    search/
      lexical.ts          # Postgres full text search query
      semantic.ts         # pgvector cosine similarity query
      fusion.ts           # Reciprocal Rank Fusion implementation
    cache/
      redis.ts
    config.ts             # env var loading and validation
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
  README.md
  LICENSE
```

## Environment variables

```
POSTGRES_URL=postgres://strata:strata@localhost:5432/strata
REDIS_URL=redis://localhost:6379
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
INSTRUCT_MODEL=qwen2.5:3b-instruct
MCP_AUTH_TOKEN=<generate a random token>
```

## Docker Compose services (expected)

- `postgres`: image with pgvector preinstalled (e.g. `pgvector/pgvector:pg16`), volume mounted for persistence
- `redis`: standard redis image
- `ollama`: official ollama image, volume mounted for model storage, models pulled on first boot via an init step
- `mcp-server`: the app itself, built from the local Dockerfile

## Database schema

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;

create table memories (
  id                uuid primary key default gen_random_uuid(),
  summary           text not null,
  raw_content       text,
  embedding         vector(768) not null,
  summary_tsv       tsvector generated always as (to_tsvector('english', summary)) stored,
  tags              text[] default '{}',
  session_id        text,
  importance        smallint default 3,
  created_at        timestamptz default now(),
  last_recalled_at  timestamptz
);

create index memories_embedding_idx on memories using hnsw (embedding vector_cosine_ops);
create index memories_tsv_idx on memories using gin (summary_tsv);
create index memories_tags_idx on memories using gin (tags);
create index memories_session_idx on memories (session_id);
```

## MCP tool specifications

### `remember`

```ts
interface RememberInput {
  content: string;
  tags?: string[];
  session_id?: string;
}
interface RememberOutput {
  id: string;
  summary: string;
  tags: string[];
}
```

Flow: send `content` to the instruct model with the compression prompt (see Prompts below), parse the returned JSON for `{summary, suggested_tags}`, merge `suggested_tags` with any `tags` passed in, embed `summary` via the embedding model, insert a row, push the new memory onto the Redis hot cache list (cap at 50, evict oldest), return the output.

### `recall`

```ts
interface RecallInput {
  query: string;
  k?: number;          // default 8
  synthesize?: boolean; // default true
}
interface RecallOutput {
  answer?: string;        // present if synthesize is true
  results: {
    id: string;
    summary: string;
    tags: string[];
    score: number;
  }[];
}
```

Flow, in order, stopping early only on a cache hit:

1. Check Redis for a cached result keyed by a hash of `query`. Return immediately on hit.
2. Run lexical search: Postgres `ts_rank_cd` against `summary_tsv`, top 20.
3. Run semantic search: embed `query`, `pgvector` cosine similarity against `embedding`, top 20.
4. Fuse the two result sets with Reciprocal Rank Fusion, `k = 60` in the RRF formula, take the top `k` from the input (default 8).
5. If `synthesize` is true, pass `query` plus the fused results to the instruct model with the synthesis prompt, set `answer` to its response.
6. If `synthesize` is false, skip step 5 and return the fused results directly.
7. Update `last_recalled_at` on all returned rows.
8. Cache the output in Redis keyed by the query hash, with a short TTL (a few minutes is reasonable, since the same query re-run soon after should stay fast, but stale results should not persist long).

### `search_by_tag`

```ts
interface SearchByTagInput {
  tags: string[];
}
```

Direct Postgres filter on the `tags` array column, no embedding call, no LLM call. Cheapest possible lookup.

### `forget`

```ts
interface ForgetInput {
  id: string;
}
```

Deletes the row by id.

### `compact`

Not agent-facing, runs as a scheduled job. Selects memories with low `importance` and old or null `last_recalled_at`, groups related ones (by tag or session), sends the raw group to the instruct model to merge into a single higher-level summary, replaces the group with the merged row. Keep `raw_content` around on the originals until this logic is trusted, rather than deleting immediately.

## Reciprocal Rank Fusion

```
score(doc) = sum over each ranker r that returned doc: 1 / (k + rank_r(doc))
```

Use `k = 60`. Implement as a plain function that takes two ranked arrays of ids and returns a single ranked array, no database round trip needed for the fusion step itself, it operates on already-fetched result sets in memory.

## Prompts

### Compression prompt (used in `remember`)

Instruct the model to read the raw content and return strict JSON only, no prose, no markdown fences, with two fields: `summary` (a compact statement of durable facts or decisions, filler and conversational padding removed) and `suggested_tags` (an array of short lowercase keywords). The prompt should explicitly state the JSON schema and give one example input/output pair, since small instruct models follow format instructions more reliably with an example present.

### Synthesis prompt (used in `recall`)

Instruct the model to read the user's query and a list of candidate memory summaries, then return a single coherent answer that resolves duplicates and contradictions, in plain text, not JSON. The prompt should tell the model to say so explicitly if the candidates do not actually answer the query, rather than fabricating an answer.

Keep both prompt templates in `src/ollama/prompts.ts` as exported functions that take the dynamic content and return the full prompt string, so they can be iterated on without touching the tool logic.

## Coding conventions

- Strict TypeScript, no `any` in tool boundaries, define interfaces for every tool input and output as shown above
- Every external call (Postgres, Redis, Ollama) wrapped in try/catch with a clear error surfaced back through MCP, not swallowed
- Keep the Ollama client, the db client, and the redis client each as small single-purpose modules with no cross-imports, so any one of the three can be swapped later without touching the others
- No business logic inside `server.ts`, it should only wire up tool registration, actual logic lives in `src/mcp/tools/*`

## Build order

1. Docker Compose stack up, Postgres schema applied, confirm a manual embedding call against Ollama works
2. `remember` and `recall` (`synthesize: false` path only) working end to end against a real MCP client
3. Lexical search and RRF fusion added into `recall`
4. Synthesis path added, `qwen2.5:3b-instruct` wired in
5. Redis caching on both the hot list and the recall query cache
6. `search_by_tag`, `forget`, `compact`