# Design Decisions

> Every non-obvious choice, with the reasoning that produced it. Reference the id
> (`DD-00N`) in code comments where the decision is implemented.
>
> **Do not re-derive a decision recorded here.** If you disagree, add a new
> entry that supersedes the old one and mark the old one `Superseded by DD-0NN`.
> Never silently implement the opposite.

Status values: `Accepted` · `Open` (needs resolution before the phase that
depends on it) · `Superseded`.

| id | Decision | Status |
| --- | --- | --- |
| [DD-001](#dd-001) | Single-user, single-host, local-only | Accepted |
| [DD-002](#dd-002) | stdio is the primary transport; HTTP is optional | Accepted |
| [DD-003](#dd-003) | Pin MCP SDK v1.x, not v2 | Accepted |
| [DD-004](#dd-004) | Embed the summary; FTS the summary plus truncated raw | Accepted |
| [DD-005](#dd-005) | Durable-first write path — never lose a memory to a model failure | Accepted |
| [DD-006](#dd-006) | Constrain compression output with a JSON schema at temperature 0 | Accepted |
| [DD-007](#dd-007) | Ollama runs on the host, not in Compose | Accepted |
| [DD-008](#dd-008) | Apply `nomic-embed-text` task prefixes in one place | Accepted |
| [DD-009](#dd-009) | Record embedding provenance; a model change is a breaking change | Accepted |
| [DD-010](#dd-010) | Corpus-version-scoped cache keys | Accepted |
| [DD-011](#dd-011) | Cache hits still record usage | Accepted |
| [DD-012](#dd-012) | Compaction and deletion are append-only | Accepted |
| [DD-013](#dd-013) | Migrations are authoritative; full schema lands in migration 001 | Accepted |
| [DD-014](#dd-014) | Parse search input with `websearch_to_tsquery` | Accepted |
| [DD-015](#dd-015) | Cut the Redis hot list from v1 | Accepted |
| [DD-016](#dd-016) | RRF `k` is tunable; expose rank score and raw similarity separately | Accepted |
| [DD-017](#dd-017) | Do not tune HNSW at this scale; assert recall against exact search | Accepted |
| [DD-018](#dd-018) | Tool contracts are complete, including descriptions | Accepted |
| [DD-019](#dd-019) | Stored memory is data, never instructions | Accepted |
| [DD-020](#dd-020) | Deduplicate on exact hash now, near-duplicates later | Accepted |
| [DD-021](#dd-021) | Retrieval quality is gated by an eval harness, not judgment | Accepted |
| [DD-022](#dd-022) | Verify model behavior before writing application code | Accepted |
| [DD-023](#dd-023) | Near-duplicate cosine threshold | Open |
| [DD-024](#dd-024) | Whether `qwen2.5:3b` is adequate for compaction | Open |
| [DD-025](#dd-025) | Added dependencies: Zod, pino, and nothing else | Accepted |

---

### DD-001
**Single-user, single-host, local-only.** `Accepted` · 2026-08-04 · inherited from `context.md`

No multi-tenancy, no scale-out, no cloud, no external API calls. Every model and
every byte of storage stays on hardware the user controls.

**Consequences:** no tenant column, no RLS, no sharding. Single Postgres, single
Redis, single Ollama. Speculative generality toward multi-user is a cost with no
payoff and is explicitly rejected.

---

### DD-002
**stdio is the primary transport; HTTP is optional.** `Accepted` · 2026-08-04

`context.md` lists Hono as the "web/MCP server framework", which implies a
standing HTTP server that clients dial into. But the intended clients — Claude
Code, Cursor, Claude Desktop — spawn local MCP servers as child processes and
speak over stdin/stdout. The MCP SDK's own guidance assigns stdio to "local
servers spawned as child processes" and Streamable HTTP to "remote servers
accessible over the network."

Choosing HTTP as primary would inherit session management, Host/Origin
validation, DNS-rebinding protection, and OAuth resource-server semantics — all
to solve a networking problem this project does not have (DD-001).

**Decision:** stdio by default. Streamable HTTP behind an explicit `--http`
flag, bound to `127.0.0.1`, for admin/health endpoints and triggering
compaction. Hono stays in the stack only to serve that optional surface. The
deprecated HTTP+SSE transport is not implemented.

**Consequences:**
- **stdout is the protocol channel.** All logging goes to stderr. One stray
  `console.log` corrupts the JSON-RPC stream and presents as a client bug. This
  is the easiest way to break Strata.
- `MCP_AUTH_TOKEN` is meaningful only in `--http` mode. Under stdio the parent
  process is the trust boundary.
- The `mcp-server` Compose service is only for `--http` mode; Compose otherwise
  provides dependencies while the client spawns the server itself.

---

### DD-003
**Pin MCP SDK v1.x, not v2.** `Accepted` · 2026-08-04

The TypeScript SDK forked into two live lines: `@modelcontextprotocol/sdk`
1.30.x (stable, committed to bug and security fixes for at least six months) and
a v2 line split into `@modelcontextprotocol/server`, `/client`, `/hono`, which
was published days before this project started.

Both expose the same authoring API (`McpServer.registerTool`), so the migration
cost later is small — the SDK ships a v1→v2 codemod.

**Decision:** build on `@modelcontextprotocol/sdk` v1.x. Use `@hono/mcp` if the
optional HTTP path is built. Revisit when v2 has a few months of adoption, or
sooner if a needed feature is v2-only.

**Consequences:** tool input schemas are declared in Zod v4 (imported as
`zod/v4`); the SDK derives wire JSON Schema and validates arguments before the
handler runs. Do not use the deprecated `tool()` helper or hand-rolled
`setRequestHandler` plumbing.

---

### DD-004
**Embed the summary; run FTS over the summary plus truncated raw content.**
`Accepted` · 2026-08-04 · amends `context.md`

The spec indexes only `summary`, which means any exact term the compressor drops
— an error code, a version number, a function name — becomes permanently
unfindable even though `raw_content` is sitting in the row. That is silent
recall loss.

Embedding raw content is genuinely undesirable: it reintroduces the transcript
junk-drawer that compression exists to prevent, and dilutes vector quality.
Full-text indexing it costs nothing at query time.

**Decision:** the generated tsvector covers both:

```sql
summary_tsv tsvector generated always as (
  to_tsvector('english', coalesce(summary,'') || ' ' || coalesce(left(raw_content, 50000), ''))
) stored
```

Embeddings continue to cover `summary` only.

**Consequences:** the two-argument `to_tsvector` with an explicit config is
`IMMUTABLE` and therefore legal in a generated column; the one-argument form is
not and would be rejected. The `left(..., 50000)` guard is required because a
`tsvector` has a ~1MB ceiling and an oversize value fails the INSERT outright.

---

### DD-005
**Durable-first write path — never lose a memory to a model failure.**
`Accepted` · 2026-08-04 · amends `context.md`

As specified, `remember` compresses (LLM), then embeds, then inserts — and
`embedding` is `not null`. So if Ollama is down, cold-loading, or slow, the
insert is impossible and **the memory is lost**, while the calling agent has
already moved on. For a system whose entire value is durability, that is the
worst defect available.

A queue is the wrong fix — that is infrastructure for a problem DD-001 says we
do not have. Invert the order instead.

**Decision:**
1. `remember` computes `content_hash`, inserts immediately with
   `raw_content = content`, a truncated placeholder `summary`, and
   `status = 'raw'`. **This commit is the durability guarantee** and yields the
   id returned to the caller.
2. Then, best-effort inline under a hard timeout: compress → validate → update
   `summary`, embed, set `status = 'compressed'`.
3. `embedding` is **nullable**, with a `needs_embedding` flag. Lexical search
   still finds un-embedded rows (DD-004), so a degraded write remains
   recallable.
4. An idempotent repair pass drains `status = 'raw' or needs_embedding`.
5. `RememberOutput` includes `status` so the caller knows what it got.

**Consequences:** semantic search must tolerate rows with a null embedding.
Enhancement failure is a warning, never a lost write. This also removes a
build-order contradiction — see DD-013 and the build plan.

---

### DD-006
**Constrain compression output with a JSON schema at temperature 0.**
`Accepted` · 2026-08-04

A 3B instruct model will eventually emit fenced, prose-wrapped, or truncated
JSON. Ollama supports structured outputs — passing a JSON Schema in `format`
constrains generation rather than merely requesting JSON.

**Decision:** pass the schema, not `format: "json"`, with `temperature: 0`.
Still validate with Zod at the boundary. A validation failure leaves the row at
`status = 'raw'` (DD-005) — never discards the memory.

---

### DD-007
**Ollama runs on the host, not in Compose.** `Accepted` · 2026-08-04 · amends `context.md`

Ollama inside Docker on macOS has no Metal access and runs CPU-only, which makes
a containerized 3B model dramatically slower than the same model on the host.

**Decision:** run Ollama natively. Postgres and Redis stay in Compose. Set
`OLLAMA_MAX_LOADED_MODELS=2` and a long `keep_alive` so the embedding and
instruct models stay co-resident instead of evicting each other and turning a
2-second call into a 30-second cold load.

**Consequences:** `OLLAMA_URL=http://localhost:11434` from the spec is wrong for
a containerized server — `localhost` is the container. Use
`http://host.docker.internal:11434` when the server runs in Docker.

---

### DD-008
**Apply `nomic-embed-text` task prefixes in one place.** `Accepted` · 2026-08-04

`nomic-embed-text` requires task instruction prefixes — `search_document:` for
stored text, `search_query:` for queries. The prefixes exist to break biencoder
symmetry; without them the model cannot distinguish "find similar-looking text"
from "find the answer to this question," which is exactly what `recall` does.

Omitting them degrades retrieval **silently** — plausible results, quietly
worse. And it is not fixable later: unprefixed rows live in a different vector
space than prefixed queries, so retrofitting means re-embedding everything.

**Decision:** apply the prefix inside `src/ollama/client.ts`, keyed off model
family, never at call sites. Record the convention in a `meta` table.

**Consequences:** applying nomic prefixes to a non-nomic model would itself
corrupt embeddings, so the behavior must be conditional, not unconditional.
Verification is required before implementation — see DD-022 — because if
Ollama's packaged Modelfile already injects a prefix, double-prefixing is its
own bug.

---

### DD-009
**Record embedding provenance; a model change is a breaking change.**
`Accepted` · 2026-08-04

`vector(768)` hard-codes `nomic-embed-text`'s dimensionality, and nothing in the
row records which model or prefix convention produced the vector. Mixing
embeddings from two models in one column produces meaningless similarities with
no error.

**Decision:** store `embedding_model` on every row. Changing the embedding model
requires a migration and a full re-embed, and is treated as a breaking change,
not a config tweak. Verify returned vector length before insert and surface a
mismatch as `EMBEDDING_DIM_MISMATCH` rather than letting Postgres reject it.

---

### DD-010
**Corpus-version-scoped cache keys.** `Accepted` · 2026-08-04 · amends `context.md`

The spec keys the recall cache on `hash(query)` with a TTL and never invalidates
it. Two defects follow. First, `forget` deletes a row and touches nothing in
Redis, so the next identical `recall` serves the forgotten memory from cache —
possibly baked into a synthesized `answer` where its provenance is invisible. A
`forget` that does not forget is a trust defect, not a staleness annoyance.
Second, the key omits `k` and `synthesize`, so `k=8` collides with `k=50` and a
`synthesize: false` call can return a cached `answer`.

**Decision:** maintain `strata:corpus:v` in Redis and `INCR` it on every
mutation (`remember`, `forget`, compaction). Cache key becomes
`recall:v{version}:{hash(normalized_query|k|synthesize|session_id)}`.

**Consequences:** stale entries become unreachable instantly and expire on their
own TTL. No key scanning, no reverse index, no invalidation logic to get wrong.
Losing the counter is safe — it only costs a cache generation.

---

### DD-011
**Cache hits still record usage.** `Accepted` · 2026-08-04 · amends `context.md`

The spec returns at step 1 on a cache hit and never reaches the step 7
`last_recalled_at` update. But cache hits occur precisely on *repeated* queries
— the hottest retrieval paths. Those rows therefore look coldest to compaction
exactly *because* they are popular, so compaction merges away the most-used
memories. Popularity causes deletion.

**Decision:** on cache hit, fire-and-forget an update of `last_recalled_at` and
`recall_count` outside the response path. Compaction must never depend on a
signal the cache can suppress.

---

### DD-012
**Compaction and deletion are append-only.** `Accepted` · 2026-08-04 · amends `context.md`

The spec's compaction has four compounding defects: it selects on `importance`,
which no tool ever writes (so every row is `3` and the predicate matches the
entire corpus); its recency signal was corrupted by the cache-hit gap (DD-011);
it contradicts itself by both replacing originals and keeping their
`raw_content`; and nothing bounds recursive summarization, so merges of merges
drift toward vague and can fabricate claims present in no input.

**Decision:** compaction never deletes. Add `superseded_by uuid references
memories(id)`, `deleted_at timestamptz`, `compaction_depth smallint default 0`.
A merge inserts a new row at `depth = max(inputs) + 1` and sets `superseded_by`
on its inputs. All reads filter `where superseded_by is null and deleted_at is
null`. `forget` becomes a soft delete, with a separate hard-purge path for
genuine erasure that also bumps the corpus version (DD-010).

- Cap `compaction_depth <= 1` until measured.
- Eligibility is age plus zero usage, not `importance`:
  `greatest(created_at, coalesce(last_recalled_at, created_at)) < now() -
  interval '30 days' and recall_count = 0 and compaction_depth = 0`.
- A dry-run mode is mandatory, and compaction ships disabled by default.
- Correctness is tested against a **stubbed** instruct model on a fixed corpus.
  This is the one component that must have deterministic tests.

**Consequences:** every merge is reversible via recorded provenance.
Compaction is the only component that destroys information, under LLM judgment,
unattended — it gets the strictest safety requirements in the system.

---

### DD-013
**Migrations are authoritative; the full schema lands in migration 001.**
`Accepted` · 2026-08-04 · amends `context.md`

The spec's layout has both `schema.sql` and `migrations/`, with neither declared
authoritative. In an agent-driven build that guarantees drift: an agent edits
`schema.sql` in a later phase, nothing changes in the running database, and
nobody notices. Compounding it, the pgvector image only runs
`docker-entrypoint-initdb.d` when the data volume is empty.

**Decision:** `migrations/NNN_*.sql` plus a `schema_migrations` table is the
single source of truth, applied on boot. `schema.sql` is deleted, or generated
as a read-only dump. The runner is roughly 40 lines and needs no new dependency.

Every column required by DD-005, DD-009, DD-011, DD-012, and DD-020 ships in
**migration 001**. Late schema changes force agents to rewrite tools they have
already finished.

---

### DD-014
**Parse search input with `websearch_to_tsquery`.** `Accepted` · 2026-08-04

Agents pass natural-language queries. `to_tsquery('english', 'what did we decide
about auth?')` raises a syntax error — so the lexical path would throw on
ordinary input. The query-side text search config must also match the one baked
into the generated column (`'english'`), or matching silently degrades.

**Decision:** use `websearch_to_tsquery`, which never throws on arbitrary user
input, with an explicit `'english'` config on both sides.

---

### DD-015
**Cut the Redis hot list from v1.** `Accepted` · 2026-08-04 · amends `context.md`

The spec writes a capped list of the 50 most recent memories and never specifies
anything that reads it. It duplicates what `order by created_at desc limit 50`
answers trivially, while adding a consistency liability on every write and
delete.

**Decision:** remove it. Do not ship a cache with no reader. If recency-aware
retrieval is wanted later, the honest form is a `recent_context` tool or
prepending recent memories to synthesis — design that when a consumer exists.

---

### DD-016
**RRF `k` is tunable; expose rank score and raw similarity separately.**
`Accepted` · 2026-08-04

`k = 60` comes from TREC runs over ~1000 documents. Over 20-item lists every
score lands in 1/61…1/80, so within-list ranking is nearly ignored and the only
real signal is "appeared in both lists." Defensible for hybrid search, but it
should be deliberate rather than inherited.

Separately, the spec returns this `score` to the agent. An RRF score is
**ordinal only** — an agent cannot threshold on it meaningfully.

**Decision:** make `k` a named constant, tuned against the eval harness
(DD-021); try 10–20. Return both `score` (documented as rank-only) and a raw
`similarity`.

**Consequences:** an empty lexical list cleanly degrades to vector order with no
division by zero; truncating 40 candidates to 8 is intended behavior, not loss.

---

### DD-017
**Do not tune HNSW at this scale; assert recall against exact search.**
`Accepted` · 2026-08-04

HNSW builds fine on an empty table and incorporates rows as they are inserted —
unlike IVFFlat, whose k-means training needs data present at build time. So
creating the index in migration 001 is correct. Cosine (`vector_cosine_ops`) is
right for nomic. At single-user scale (under ~10k rows) the planner may seqscan
anyway, and exact search is *better*: 100% recall, sub-millisecond.

**Decision:** do not tune HNSW. Add a recall-versus-exact assertion to the eval
harness (DD-021) instead, and revisit only if it fails.

**Consequences:**
- `hnsw.ef_search` must be set with **`SET LOCAL` inside a transaction**. `pg`
  uses a connection pool, so a bare `SET` leaks into whatever unrelated query
  borrows that connection next.
- `ef_construction = 128` is a reasonable build-time value (default 64 is low);
  `m = 16` is fine.
- If semantic search is ever filtered by `session_id` or tags, pgvector's
  post-filtering will silently under-return; that requires
  `hnsw.iterative_scan = 'relaxed_order'`.

---

### DD-018
**Tool contracts are complete, including descriptions.** `Accepted` · 2026-08-04

The spec leaves gaps an agent will fill by guessing: `SearchByTagInput` declares
no output type; tag matching is never defined as AND or OR (`tags @> $1` versus
`tags && $1` — GIN supports both); `search_by_tag` has no limit, so the result
set is unbounded; `forget` returns nothing, so a caller cannot distinguish
"deleted" from "no such id"; and `recall` has no `session_id` filter, which
makes the `session_id` column and its index pointless.

Most importantly there are **no MCP tool descriptions**. For an agent-facing
memory server the tool description *is* the product surface — it determines
whether `remember` ever gets called at all.

**Decision:** specify every input and output type; tag matching defaults to OR
(`&&`) with an optional `match: 'any' | 'all'`; every list endpoint has a
`limit` with a default; `forget` returns `{deleted: boolean}`; `recall` takes an
optional `session_id`. Tool descriptions are tracked deliverables, written and
reviewed like code.

---

### DD-019
**Stored memory is data, never instructions.** `Accepted` · 2026-08-04

Synthesis feeds stored text — authored by one agent, possibly pasted from the
web — into an instruct model and returns the result to another agent as an
authoritative answer. That is an indirect prompt-injection sink. Single-user and
local lowers the stakes but does not remove them, and it is nearly free to
handle now versus awkward to retrofit.

**Decision:** in `prompts.ts`, wrap each candidate in explicit delimiters with
an instruction that candidate text is data and never instructions. Never merge
stored text into a system-prompt region.

---

### DD-020
**Deduplicate on exact hash now, near-duplicates later.** `Accepted` · 2026-08-04

Nothing in the spec prevents an agent from re-telling the same fact every
session. Near-duplicate rows then dominate recall results and crowd out
everything else.

**Decision:** store `content_hash` in migration 001 and use it for exact
idempotency on `remember`. Near-duplicate detection by cosine threshold is
deferred until a threshold can be measured on real data — see DD-023.

---

### DD-021
**Retrieval quality is gated by an eval harness, not judgment.**
`Accepted` · 2026-08-04

"Recall works" is not a verifiable exit criterion. Retrieval quality is
invisible without measurement, so an agent-driven build can complete every phase
while quality silently degrades — the prefix bug (DD-008) is exactly that
failure mode.

**Decision:** a seeded eval corpus plus `npm run eval` reporting recall@8 lands
in Phase 1, before any retrieval feature. Phase exits are gated on the number:
hybrid search must *beat* semantic-only; compression must not *reduce* recall;
compaction must not regress it.

**Consequences:** the harness is the yardstick for DD-016's `k`, DD-017's
recall-versus-exact assertion, and DD-023's threshold. Build it before the thing
it measures.

---

### DD-022
**Verify model behavior before writing application code.** `Accepted` · 2026-08-04

Three assumptions in this document are about *model behavior*, not design:
whether prefixes help (DD-008), whether Ollama already injects one, and the real
usable context window. Each costs an hour to check against a live Ollama and
costs a full re-embed if discovered late.

**Decision:** Phase 0 is a throwaway script against Ollama — no application code
— producing `docs/model-findings.md` with real numbers: prefixed versus
unprefixed cosine on ~10 pairs, `ollama show --modelfile nomic-embed-text` to
check for a TEMPLATE that injects a prefix, `prompt_eval_count` versus expected
tokens for both models, and one structured-output call. DD-008 is implemented
only after this confirms it.

---

### DD-023
**Near-duplicate cosine threshold.** `Open`

What cosine similarity marks two memories as near-duplicates (DD-020) is
model- and corpus-specific. Any number chosen now would be invented.

**Resolve by:** measuring on real data after DD-008 is implemented and the eval
corpus exists. Needed before near-duplicate suppression ships; not blocking
earlier phases.

---

### DD-024
**Whether `qwen2.5:3b` is adequate for compaction.** `Open`

Merging several memories without fabricating is a harder task than summarizing
one. The model may be adequate for compression (DD-006) and not for compaction.

**Resolve by:** reviewing dry-run output on the eval corpus at the compaction
phase gate. Be prepared to conclude that compaction needs a larger model, or
should not be automated at all.

---

### DD-025
**Added dependencies: Zod, pino, and nothing else.** `Accepted` · 2026-08-04

`context.md`'s stack list omits two runtime dependencies the design now requires.
Recording them so the "no undeclared dependencies" rule stays enforceable.

- **Zod v4** — not really optional: it is the MCP SDK's peer dependency for tool
  input schemas (DD-003), and it is the validator at the three boundaries
  (env, LLM output, tool input) required by the coding standards.
- **pino** — structured logging to stderr (DD-002). Rejected alternative:
  hand-rolled JSON logging, which would re-implement redaction, levels, and child
  loggers badly.

**Consequences:** the migration runner is deliberately hand-written (~40 lines)
rather than pulling in a migration framework — the need is a table and an ordered
directory scan, which does not justify a dependency. Anything beyond Zod and pino
needs a new decision entry.
