# Architecture

> How Strata is built. Sections are independent — read the one your task needs.
>
> [Runtime topology](#runtime-topology) · [Module map](#module-map) ·
> [Data model](#data-model) · [Write path](#write-path) ·
> [Retrieval pipeline](#retrieval-pipeline) · [Model layer](#model-layer) ·
> [Cache layer](#cache-layer) · [Compaction](#compaction) ·
> [Tool contracts](#tool-contracts) · [Failure modes](#failure-modes)
>
> Where this document amends `context.md`, the amendment is authoritative and
> carries a `DD-0NN` reference to [design-decisions.md](./design-decisions.md).

## System shape

```
        MCP client (Claude Code / Cursor / Claude Desktop)
                        │  stdio (primary, DD-002)
                        ▼
        ┌───────────────────────────────────┐
        │  src/mcp/server.ts                │  registration + wiring only
        │    tools: remember, recall,       │
        │           search_by_tag, forget   │
        └───────────────────────────────────┘
                 │            │            │
        ┌────────▼───┐  ┌─────▼─────┐  ┌───▼────────┐
        │ src/db     │  │ src/cache │  │ src/ollama │   mutually isolated
        │ (pg)       │  │ (redis)   │  │ (HTTP)     │
        └────────┬───┘  └─────┬─────┘  └───┬────────┘
                 ▼            ▼            ▼
           Postgres 16     Redis 7     Ollama (on host, DD-007)
           + pgvector                  ├─ nomic-embed-text (768d)
           [durable]      [disposable] └─ qwen2.5:3b-instruct

        Background: repair pass (drains status='raw'), compaction (opt-in)
```

Postgres is the only durable component. Redis is disposable. Ollama is an
enhancement service — the system stays correct without it.

## Runtime topology

### Transport: stdio primary, HTTP optional (DD-002)

MCP clients spawn the server as a child process and speak over stdin/stdout.
That is the primary and default path. An optional Streamable HTTP mode sits
behind a `--http` flag, bound to `127.0.0.1`, for health/admin endpoints and
triggering compaction.

Non-negotiable consequence: **stdout is the protocol channel.** All logging goes
to **stderr**. A single stray `console.log` corrupts the JSON-RPC stream and
presents as a client-side bug. Establish the stderr-only logger before writing
any tool.

`MCP_AUTH_TOKEN` applies only in `--http` mode. Under stdio the parent process
is the trust boundary. The deprecated HTTP+SSE transport is not implemented.

### Services

| Component | Where it runs | Why |
| --- | --- | --- |
| `postgres` | Compose, `pgvector/pgvector:pg16`, named volume | Durable store |
| `redis` | Compose, `redis:7-alpine` | Disposable cache; nothing durable |
| `ollama` | **Host, not Compose** (DD-007) | Docker on macOS has no Metal access; containerized inference is CPU-only and far slower |
| `mcp-server` | Client-spawned (stdio) or Compose (`--http` only) | Both modes are the same binary |

Ollama needs `OLLAMA_MAX_LOADED_MODELS=2` and a long `keep_alive` so the
embedding and instruct models stay co-resident. Otherwise they evict each other
and a 2-second call becomes a 30-second cold load.

Model pulls must be idempotent and complete before the server serves traffic.
Gate readiness on both models actually responding, not on a process starting.

### Environment

```
POSTGRES_URL=postgres://strata:strata@localhost:5432/strata
REDIS_URL=redis://localhost:6379
OLLAMA_URL=http://localhost:11434     # host.docker.internal if server is containerized (DD-007)
EMBEDDING_MODEL=nomic-embed-text
INSTRUCT_MODEL=qwen2.5:3b-instruct
MCP_AUTH_TOKEN=<random>               # --http mode only
COMPACTION_ENABLED=false              # DD-012: off by default
```

Validated once at startup in `src/config.ts`. Invalid config refuses to boot.

## Module map

```
src/
  mcp/
    server.ts          entrypoint; transport selection; tool registration. No logic.
    tools/
      remember.ts      durable insert → best-effort compress/embed (DD-005)
      recall.ts        cache → lexical ∥ semantic → fuse → synthesize
      searchByTag.ts   single indexed SQL filter
      forget.ts        soft delete + corpus version bump
      compact.ts       scheduled, opt-in, append-only merge (DD-012)
    jobs/
      repair.ts        drains status='raw' / needs_embedding (DD-005)
  db/
    client.ts          pg Pool wrapper: query(), withTransaction(), close()
    migrations/        NNN_*.sql, forward-only, authoritative (DD-013)
    migrate.ts         runner + schema_migrations table
  ollama/
    client.ts          embed() + generate(); applies task prefixes (DD-008); timeouts
    prompts.ts         buildCompressionPrompt(), buildSynthesisPrompt()
  search/
    lexical.ts         websearch_to_tsquery + ts_rank_cd (DD-014)
    semantic.ts        pgvector cosine; SET LOCAL ef_search in a transaction (DD-017)
    fusion.ts          pure RRF over ranked id lists
  cache/
    redis.ts           recall cache, corpus version counter (DD-010)
  config.ts            env parsing/validation
  errors.ts            StrataError + code union
eval/
  corpus.ts            seeded eval corpus
  run.ts               recall@8 harness (DD-021)
```

There is no `schema.sql` (DD-013) and no Redis hot list (DD-015).

Dependency direction is one-way:

```
server.ts → tools/* → search/* → {db, cache, ollama} → config
```

`db`, `cache`, and `ollama` never import each other; each must be swappable
without touching the others. Composition happens in `tools/*`.

`fusion.ts` imports nothing and stays pure, so retrieval's most quality-critical
logic can be tested exhaustively without infrastructure.

## Data model

All of this ships in **migration 001** (DD-013). Adding these columns later
forces rewrites of tools already built.

```sql
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
  superseded_by     uuid references memories(id),     -- DD-012
  deleted_at        timestamptz,                      -- DD-012: soft delete
  created_at        timestamptz not null default now(),
  last_recalled_at  timestamptz
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
```

### Every read filters live rows

```sql
where superseded_by is null and deleted_at is null
```

This is not optional and applies to lexical search, semantic search,
`search_by_tag`, and compaction candidate selection. Omitting it resurrects
forgotten and superseded memories — the exact failure DD-012 exists to prevent.

### Column semantics

| Column | Notes |
| --- | --- |
| `summary` | Starts as a truncated placeholder, replaced by the compressed form when enhancement succeeds (DD-005) |
| `raw_content` | Original input. Full-text indexed via `summary_tsv`, never embedded (DD-004) |
| `status` | `'raw'` = durable but not yet compressed; `'compressed'` = enhanced. Drives the repair pass |
| `embedding` | Nullable. Null means semantic search cannot see this row yet, but lexical search can |
| `embedding_model` | Which model produced the vector. Mixing models silently produces meaningless similarities (DD-009) |
| `summary_tsv` | Generated. Postgres maintains it; never write to it. The `left()` guard prevents the ~1MB tsvector ceiling from failing inserts |
| `importance` | Currently written by nothing. **Not** used for compaction eligibility (DD-012) |
| `recall_count` / `last_recalled_at` | Usage signal for compaction. Updated on every successful recall **including cache hits** (DD-011) |
| `compaction_depth` | Bounds recursive summarization drift. Capped at 1 until measured |
| `superseded_by` | Set on inputs when a merged row replaces them. Provenance makes merges reversible |

### Schema authority

`migrations/NNN_*.sql` plus a `schema_migrations` table is the single source of
truth, applied on boot (DD-013). Note that the pgvector image only runs
`docker-entrypoint-initdb.d` when the data volume is empty, which is why boot-time
migrations — not init scripts — own the schema.

### Vector index notes (DD-017)

- HNSW builds fine on an empty table and absorbs rows as they are inserted.
  Unlike IVFFlat, no data is needed at build time.
- Cosine matches `nomic-embed-text`, which produces normalized vectors.
- **`hnsw.ef_search` must be set with `SET LOCAL` inside a transaction.** `pg`
  pools connections, so a bare `SET` leaks into whatever unrelated query borrows
  that connection next.
- Under ~10k rows the planner may seqscan, and exact search is *better*: 100%
  recall, sub-millisecond. Do not tune HNSW; assert recall against exact search
  in the eval harness instead.
- Filtering semantic search by `session_id` or tags triggers pgvector
  post-filtering, which silently under-returns. That needs
  `hnsw.iterative_scan = 'relaxed_order'`.

## Write path

`remember(content, tags?, session_id?)` — **durability first** (DD-005).

**Stage 1: the durable commit. No model calls.**

1. Compute `content_hash`. If a live row already has it, return that row —
   idempotent (DD-020).
2. Insert with `raw_content = content`, `summary = left(content, N)`,
   `status = 'raw'`, `needs_embedding = true`, plus caller tags and
   `session_id`.
3. Bump the corpus version (DD-010).

The transaction committing here **is** the durability guarantee, and it yields
the id returned to the caller. Nothing after this point can lose the memory.

**Stage 2: best-effort enhancement, inline, under a hard timeout (~5s).**

4. Compress via the instruct model with a constrained JSON schema at
   temperature 0 (DD-006).
5. Validate with Zod. On failure, leave `status = 'raw'` and warn — never
   discard.
6. Merge `suggested_tags` with caller tags; normalize (lowercase, trim, dedupe).
7. Embed the summary with the `search_document:` prefix (DD-008). Verify the
   returned length is 768 before writing; a mismatch surfaces as
   `EMBEDDING_DIM_MISMATCH`.
8. Update `summary`, `embedding`, `embedding_model`, `needs_embedding = false`,
   `status = 'compressed'`.

**Stage 3: repair.** An idempotent background pass drains rows where
`status = 'raw' or needs_embedding`, re-running stage 2. Safe to run repeatedly.

`RememberOutput` includes `status`, so a caller can tell whether it got a
compressed memory or a durable raw one.

Why this order: with the spec's original sequence (compress → embed → insert
with `embedding not null`), an Ollama outage made the insert *impossible* and the
memory was lost while the calling agent moved on. A degraded write is acceptable;
a lost write is not.

## Retrieval pipeline

`recall(query, k = 8, synthesize = true, session_id?)` — cheapest stage first,
early return only on a cache hit.

| Stage | Cost | Behavior |
| --- | --- | --- |
| 1. Recall cache | Redis GET | Key includes corpus version, normalized query, `k`, `synthesize`, `session_id` (DD-010). Hit → return, **but still record usage** (DD-011) |
| 2. Lexical | 1 SQL | `websearch_to_tsquery('english', …)` + `ts_rank_cd` over `summary_tsv`, top 20 (DD-014) |
| 3. Semantic | 1 embed + 1 SQL | Embed query with `search_query:` prefix (DD-008), cosine similarity, top 20. Skips rows with null embedding |
| 4. Fusion | pure CPU | RRF over the two ranked lists, take top `k` |
| 5. Synthesis | 1 LLM call | Only if `synthesize`. Candidates are delimited as data, never instructions (DD-019) |
| 6. Bookkeeping | 1 SQL | `last_recalled_at = now()`, `recall_count + 1` on returned rows |
| 7. Cache write | Redis SET | Store under the versioned key with a short TTL |

Stages 2 and 3 are independent and **must run concurrently** (`Promise.all`).
Sequential awaits here double read latency for nothing.

The LLM only ever sees the fused shortlist, never the corpus. That is what keeps
read latency bounded as the store grows.

### Lexical specifics (DD-014)

`to_tsquery` raises a syntax error on natural language, and agents pass full
sentences — so `websearch_to_tsquery` is required, not preferred. The
`'english'` config must be stated explicitly on the query side to match the one
baked into the generated column; a mismatch degrades matching silently.

### Fusion

```
score(doc) = Σ over each ranker r that returned doc:  1 / (RRF_K + rank_r(doc))
```

RRF uses **rank only**, never the underlying scores — `ts_rank_cd` values and
cosine distances are not comparable quantities, and rank is their only common
currency.

`RRF_K` is a tuned constant, not a fixed 60 (DD-016). Over 20-item lists, `k=60`
compresses every score into 1/61…1/80, so within-list ranking is nearly ignored
and the only real signal becomes "appeared in both lists." Values of 10–20 are
worth testing against the eval harness.

Results carry both `score` (ordinal, rank-derived, not thresholdable) and a raw
`similarity` an agent can actually reason about.

Degenerate cases, all expected rather than exotic:

- **Lexical empty** (conceptual query, no keyword overlap) → collapses to pure
  semantic order. Correct, not an error.
- **Semantic empty** (empty corpus, unembedded rows, or a degraded embed call)
  → collapses to pure lexical.
- **Both empty** → `{results: []}`, and if synthesizing, an answer that says
  nothing relevant was found. Never fabricate.
- **Zero overlap** → RRF interleaves by rank. Expected.

## Model layer

`src/ollama/client.ts` exposes exactly two operations — `embed()` and
`generate()` — and knows nothing about memories, Postgres, or Redis.

Requirements:

- Every call carries a timeout via `AbortSignal.timeout`. A stuck generation
  must never hang a tool call.
- Compression uses Ollama **structured outputs** — a JSON Schema in `format`,
  not `format: "json"` — at `temperature: 0` (DD-006). Determinism matters more
  than creativity here.
- Failures split into `OLLAMA_UNAVAILABLE` (transport/timeout) and
  `OLLAMA_BAD_RESPONSE` (reachable, unusable output). Different problems,
  different fixes; they must not collapse into one code.

### Embedding task prefixes (DD-008)

`nomic-embed-text` requires task prefixes: `search_document:` for stored text,
`search_query:` for queries. They exist to break biencoder symmetry — without
them the model cannot distinguish "find similar-looking text" from "find the
answer to this question," which is exactly what `recall` does.

Rules:

- Applied **inside the client**, keyed off model family — never at call sites,
  and never unconditionally (prefixing a non-nomic model corrupts its
  embeddings just as badly).
- The convention is recorded in the `meta` table.
- **Verify before implementing** (DD-022): if Ollama's packaged Modelfile
  already injects a prefix, doing it again is its own bug.

Getting this wrong degrades retrieval with no error, and is unfixable without
re-embedding the entire corpus.

### Prompts

Both templates live in `src/ollama/prompts.ts` as functions taking dynamic
content and returning the full prompt, so prompts can be iterated without
touching tool logic.

**Compression** — strict JSON, schema-constrained. Fields: `summary` (compact
durable facts, filler removed) and `suggested_tags` (short lowercase keywords).
State the schema explicitly and include one worked example; small instruct models
follow format instructions far more reliably with an example present.

**Synthesis** — read the query plus candidates, return one coherent plain-text
answer resolving duplicates and contradictions, and say so explicitly when the
candidates do not answer the query rather than fabricating.

**Injection hardening (DD-019).** Stored text is untrusted — one agent authored
it, and it may include web content pasted in through `remember`. Wrap each
candidate in explicit delimiters, instruct the model that candidate text is data
and never instructions, and never merge stored text into a system-prompt region.

### Parsing model output

Even with constrained generation, validate at the boundary: extract the
outermost JSON object, `JSON.parse` into `unknown`, then schema-validate. Tests
must cover fenced JSON, prose-wrapped JSON, truncated JSON, and valid JSON with
wrong field names. A parse failure leaves the row at `status = 'raw'` (DD-005).

## Cache layer

Redis holds **nothing durable**. Flushing it must cost latency only, never data.
Every read path must work with Redis entirely absent.

There is one cache, not two — the hot list is cut (DD-015).

| Cache | Key | Contents |
| --- | --- | --- |
| Recall cache | `recall:v{corpusVersion}:{hash(normalizedQuery\|k\|synthesize\|sessionId)}` | Full `RecallOutput`, short TTL |

### Version-scoped invalidation (DD-010)

`strata:corpus:v` is `INCR`d on every mutation — `remember`, `forget`,
compaction. Because the version is part of every key, stale entries become
unreachable the instant the corpus changes and expire on their own TTL. No key
scanning, no reverse index, no invalidation logic to get wrong. Losing the
counter costs a cache generation, nothing more.

Two bugs this closes:

- A `forget` followed by an identical `recall` served the deleted memory from
  cache — possibly embedded in a synthesized `answer` where its provenance was
  invisible. A `forget` that does not forget is a trust defect, not staleness.
- Keying on the query alone made `k=8` collide with `k=50`, and let a
  `synthesize: false` call return a cached `answer`.

Normalize the query (trim, collapse whitespace, lowercase) before hashing so
trivially different queries share an entry.

**Run Redis without persistence.** The counter and the entries it scopes must
share a lifetime. If Redis persisted cached results across a restart but lost the
counter, `INCR` would restart at 1 and could resurrect a stale generation. Since
Redis holds nothing durable by design, disabling persistence makes that class of
bug unreachable rather than merely unlikely.

### Usage tracking on cache hits (DD-011)

A cache hit must still update `last_recalled_at` and `recall_count`,
fire-and-forget, outside the response path. Cache hits happen on *repeated*
queries — the hottest paths — so skipping this makes the most-used memories look
coldest to compaction, which then merges them away. Popularity would cause
deletion.

## Compaction

`compact` is a scheduled job, **never** an agent-facing tool, and **disabled by
default**.

It is the only component that destroys information, under LLM judgment, with
nobody watching. It gets the strictest requirements in the system (DD-012).

### Append-only

Nothing is deleted. A merge inserts a new row with
`compaction_depth = max(inputs) + 1` and sets `superseded_by` on its inputs. All
reads filter live rows. `forget` is likewise a soft delete, with a separate
hard-purge path for genuine erasure that also bumps the corpus version.

### Eligibility

Age plus zero usage — **not** `importance`:

```sql
where superseded_by is null
  and deleted_at is null
  and greatest(created_at, coalesce(last_recalled_at, created_at)) < now() - interval '30 days'
  and recall_count = 0
  and compaction_depth = 0
```

The spec selected on low `importance`, but no tool ever writes `importance`, so
every row sits at the default `3` and the predicate would match the entire
corpus.

### Safety requirements

- **Dry run is mandatory** — emit proposed merges as JSON, write nothing.
- **Transactional** — a merge is all-or-nothing; a crash mid-merge must leave the
  group intact.
- **Depth-capped** at 1 until measured. Merging summaries-of-summaries with a 3B
  model drifts toward vague and can fabricate claims present in no input.
- **Reversible** via `superseded_by` provenance.
- **Deterministically tested** against a *stubbed* instruct model on a fixed
  corpus. This is the one component that must not depend on live model output
  for its tests.
- Recall@8 must not regress after a real run (DD-021).

Whether `qwen2.5:3b` is good enough to merge without fabricating is unresolved —
see DD-024.

## Tool contracts

Contracts are public API. Wire field names stay exactly as specified;
`camelCase` conventions do not apply across the MCP boundary. Every input and
output is declared — gaps get filled by guessing (DD-018).

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
  status: "raw" | "compressed";   // DD-005
}

interface RecallInput {
  query: string;
  k?: number;            // default 8
  synthesize?: boolean;  // default true
  session_id?: string;   // DD-018: optional scope filter
}
interface RecallResult {
  id: string;
  summary: string;
  tags: string[];
  score: number;         // RRF, ordinal only — not thresholdable (DD-016)
  similarity: number;    // raw cosine, agent-usable
}
interface RecallOutput {
  answer?: string;       // present iff synthesize was true and synthesis succeeded
  results: RecallResult[];
}

interface SearchByTagInput {
  tags: string[];
  match?: "any" | "all"; // default "any" → tags && $1  (DD-018)
  limit?: number;        // default 20
}
interface SearchByTagOutput {
  results: { id: string; summary: string; tags: string[]; created_at: string }[];
}

interface ForgetInput { id: string; }
interface ForgetOutput { deleted: boolean; }   // DD-018: distinguishes no-such-id
```

Tag matching defaults to OR (`tags && $1`); `match: "all"` uses `tags @> $1`.
Both use the GIN index.

### Registration

Tools register through `McpServer.registerTool` on MCP SDK v1.x (DD-003), with
Zod v4 input schemas. The SDK derives the wire JSON Schema and validates
arguments before the handler runs — so Zod schemas are the single source of
truth for input types. Derive the TypeScript type from the schema rather than
maintaining both.

Handlers return a `content` array plus `structuredContent` matching the typed
output. Tool-level failures return `isError: true` with a useful message rather
than throwing raw.

### Tool descriptions are deliverables

For an agent-facing memory server, the tool description **is** the product
surface — it decides whether `remember` ever gets called. Descriptions are
written, reviewed, and iterated like code, not filled in as an afterthought.

## Failure modes

"Degrade" = serve a useful result and log a warning. "Fail" = return an error.

| Failure | `remember` | `recall` | `search_by_tag` | `forget` |
| --- | --- | --- | --- | --- |
| Postgres down | fail | fail | fail | fail |
| Redis down | degrade (skip version bump, warn) | degrade (skip cache, full pipeline) | unaffected | degrade (warn: cache may be stale) |
| Ollama down | **degrade** → `status: 'raw'`, repair later (DD-005) | degrade → lexical-only, no `answer` | unaffected | unaffected |
| Malformed LLM output | degrade → stays `status: 'raw'` | degrade → fused results, no `answer` | unaffected | unaffected |
| Embedding dim mismatch | degrade → `needs_embedding` stays true | degrade → lexical-only | unaffected | unaffected |
| Empty result set | n/a | success, `results: []` | success, `[]` | `{deleted: false}` |

The governing rule: **Postgres is load-bearing; Redis and Ollama are not.** A
read returns something useful as long as Postgres is reachable, and a write
durably lands as long as Postgres is reachable.

Note that `remember` under an Ollama outage *degrades* rather than fails — that
is the whole point of DD-005. What must never happen is accepting a `remember`
call and storing nothing.

### Error codes

`CONFIG_INVALID`, `DB_QUERY_FAILED`, `CACHE_UNAVAILABLE`, `OLLAMA_UNAVAILABLE`,
`OLLAMA_BAD_RESPONSE`, `EMBEDDING_DIM_MISMATCH`, `NOT_FOUND`, `INVALID_INPUT`.

Defined in `src/errors.ts`. Every one must be reachable and map to a sensible
MCP error response.

## Observability

Logging goes to **stderr** only — stdout is the protocol channel (DD-002).

- One structured line per tool call: tool, duration, outcome, result count,
  cache hit/miss, and for `remember` the resulting `status`.
- Per-stage `recall` timings at `debug`: cache, lexical, semantic, fusion,
  synthesis. Without these a latency regression cannot be localized.
- Count degraded operations. A steady stream of `status='raw'` writes means
  Ollama is failing and the corpus is quietly filling with uncompressed rows —
  that must be visible, not silent.
- Never log full memory content at `info`; it is user data. Never log
  `MCP_AUTH_TOKEN` or connection strings at any level.
