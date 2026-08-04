# Build Plan

> **Read only the current phase.** It is named in
> [progress-tracker.md](./progress-tracker.md) § Current state. Reading future
> phases wastes context and invites scope creep.

## How phases work

A phase is done when its exit criteria pass by **running something**. Not by
inspection, not by intent. Do not start the next phase with a failing criterion
behind you.

Four principles shape this ordering. They differ from the build order in
`context.md`, which had a hard contradiction (its phase 2 needed the instruct
model that its phase 4 introduced) and two phases with no verifiable exit.

1. **Verify model behavior before writing code that depends on it** (DD-022).
   Every critical assumption in this project is about model behavior, costs an
   hour to check, and costs a full re-embed to discover late.
2. **Build the yardstick before the thing it measures** (DD-021). Retrieval
   quality is invisible without measurement. The eval harness lands in Phase 1,
   and later phases are gated on its numbers.
3. **The full schema ships in migration 001** (DD-013). Late schema changes force
   agents to rewrite tools they already finished.
4. **One retrieval stage per phase.** Semantic → fusion → synthesis, so each
   stage's contribution to quality is measurable in isolation.

---

## Phase 0 — Documentation baseline

**Goal:** Agents find the right context without loading the whole spec.

**Exit criteria**
- [x] `docs/` contains overview, architecture, coding standards, build plan,
      progress tracker, design decisions
- [x] `AGENTS.md` routes each task type to a minimal document set
- [x] Decisions inherited from and amending `context.md` are recorded with ids

---

## Phase 1 — Model truth-finding

**Goal:** Replace three model-behavior assumptions with measured numbers. No
application code is written in this phase.

**Scope:** one throwaway script hitting Ollama directly.

- Cosine similarity on ~10 query/document pairs, prefixed vs unprefixed
- `ollama show --modelfile nomic-embed-text` — check for a TEMPLATE that already
  injects a prefix
- `prompt_eval_count` vs expected token count for both models, to find the real
  usable context window
- One structured-output call with a JSON schema, to confirm the mechanism works
  on this Ollama version

**Out of scope:** everything else. Do not start `src/`.

**Exit criteria**
- [ ] `docs/model-findings.md` committed, containing actual numbers
- [ ] Prefix question settled: prefixes measurably help **and** Ollama does not
      already inject one (if it does, DD-008 changes — record the amendment)
- [ ] Effective `num_ctx` recorded for both models
- [ ] A schema-constrained generation call returns conforming JSON

**Why first:** if prefixes are handled wrong (DD-008), retrieval degrades with
no error and the only fix is re-embedding the entire corpus. One hour here
prevents that.

---

## Phase 2 — Substrate and eval harness

**Goal:** The stack runs, the schema is final, and retrieval quality is
measurable.

**Scope**
- `package.json`, strict `tsconfig.json`, lint, test runner
- `src/config.ts` (validated env), `src/errors.ts` (`StrataError` + codes)
- `docker-compose.yml`: postgres (pgvector) + redis. **Ollama runs on the host**
  (DD-007)
- **Complete migration 001** — every column in architecture § Data model,
  including `status`, `content_hash`, `embedding_model`, `needs_embedding`,
  `recall_count`, `compaction_depth`, `superseded_by`, `deleted_at`, plus the
  `meta` table
- `src/db/migrate.ts` runner + `schema_migrations`, applied on boot
- `src/db/client.ts`: injectable `Db` with `query()`, `withTransaction()`
- `src/ollama/client.ts` — **`embed()` only**, with prefixes per Phase 1 findings
- `eval/corpus.ts` + `eval/run.ts`: seeded corpus, recall@8 against **exact**
  (non-index) similarity

**Out of scope:** MCP, tools, `generate()`, synthesis, caching.

**Exit criteria**
- [ ] `docker compose up` reaches healthy on a machine that has never run it
- [ ] Migration runner applies cleanly to an empty database and is a no-op on a
      second run
- [ ] Migration 001 contains every column the later phases need — verified
      against architecture § Data model, column by column
- [ ] `loadConfig()` throws on a missing/invalid var, naming the offender
- [ ] `npm run eval` prints a **recall@8 baseline** for brute-force search.
      This number is the yardstick for every later phase
- [ ] A 767-dimension vector is rejected; a 768d insert succeeds
- [ ] `summary_tsv` populates automatically and covers `raw_content` terms
      (DD-004)
- [ ] `tsc --noEmit` and lint clean

---

## Phase 3 — MCP transport proof

**Goal:** A real MCP client connects. Protocol risk retired while the surface
area is one trivial tool.

**Scope**
- `src/mcp/server.ts`: `McpServer` (SDK v1.x, DD-003), stdio transport, wiring
  only
- One trivial tool with a Zod v4 input schema
- **stderr-only structured logger**, established before any real tool exists
- Client config snippet in the README

**Out of scope:** `remember`, `recall`, HTTP mode, auth.

**Exit criteria**
- [ ] Claude Code (or Cursor/Claude Desktop) lists the server's tools
- [ ] The trivial tool is callable and returns a `content` result
- [ ] Invalid arguments are rejected by the schema before the handler runs
- [ ] Nothing reaches stdout except protocol frames — verified by inspecting the
      stream, not assumed
- [ ] `server.ts` contains no business logic

**Risk:** one stray `console.log` breaks the connection in a way that looks like
a client bug. That is why the logger comes before the tools.

---

## Phase 4 — Durable write and semantic recall, no instruct model

**Goal:** Memories are durably stored and retrievable by meaning, with zero LLM
involvement.

**Scope**
- `src/mcp/tools/remember.ts`: hash → **durable insert** (`status='raw'`) →
  embed with `search_document:` → update. Stage 1 commits before any model call
  (DD-005)
- `src/search/semantic.ts`: `search_query:` prefix, cosine, top 20,
  `SET LOCAL hnsw.ef_search` inside a transaction (DD-017), live-rows filter
- `src/mcp/tools/recall.ts`: semantic only, `synthesize` forced off
- `src/mcp/jobs/repair.ts`: drains `status='raw' or needs_embedding`
- Usage bookkeeping on returned rows

**Out of scope:** compression, synthesis, lexical, fusion, caching.

**Exit criteria**
- [ ] `npm run eval` recall@8 **≥ Phase 2 baseline** — proves the HNSW path
      matches exact search
- [ ] A query with **no literal keyword overlap** retrieves the right memory
- [ ] **Kill Ollama mid-run: the write still succeeds** with `status='raw'` and
      the id is returned. This is the DD-005 guarantee — test it explicitly
- [ ] The repair pass upgrades those rows to `status='compressed'` once Ollama
      returns, and is safe to run twice
- [ ] Re-`remember`ing identical content returns the existing id (DD-020)
- [ ] Rows with a null embedding are skipped by semantic search without error
- [ ] Empty corpus returns `{results: []}`, not an error

---

## Phase 5 — Lexical search and fusion

**Goal:** Exact identifiers are retrievable, and hybrid search demonstrably
beats semantic alone.

**Scope**
- `src/search/lexical.ts`: `websearch_to_tsquery('english', …)` + `ts_rank_cd`,
  top 20 (DD-014), live-rows filter
- `src/search/fusion.ts`: pure RRF, `RRF_K` tuned against the harness (DD-016)
- Wire both into `recall`, running concurrently
- Return `similarity` alongside `score`

**Exit criteria**
- [ ] `npm run eval` recall@8 **measurably beats Phase 4**. If it does not,
      hybrid search is misconfigured — and without this gate nobody would know
- [ ] A natural-language question with punctuation does **not** throw — the
      `to_tsquery` failure mode is closed (DD-014)
- [ ] A query for an exact token (error code, function name) ranks the
      containing memory top
- [ ] `fusion.ts` unit tests cover: empty lexical, empty semantic, both empty,
      full overlap, zero overlap, single-item lists
- [ ] Searches run concurrently — verified via stage timings (total ≈ max, not
      sum)
- [ ] One search path failing still returns results from the other
- [ ] The chosen `RRF_K` is recorded with the eval numbers that justified it

---

## Phase 6 — Instruct model: compression and synthesis

**Goal:** Memories are compressed on write and synthesized on read, without
losing retrievability.

**Scope**
- `generate()` in the Ollama client, with timeout
- `src/ollama/prompts.ts`: compression (schema-constrained, temperature 0,
  one worked example) and synthesis prompts
- Injection hardening — candidates delimited as data, never instructions
  (DD-019)
- Enhancement stage in `remember`; synthesis stage in `recall`
- Defensive parser + Zod validation at the boundary

**Exit criteria**
- [ ] `npm run eval` recall@8 **unchanged or better** after re-compressing the
      eval corpus — proves compression did not destroy retrievability
- [ ] Summaries are materially shorter than conversational input
- [ ] p50/p95 `remember` latency recorded in the progress tracker
- [ ] Unit tests cover malformed output: fenced, prose-wrapped, truncated, wrong
      keys
- [ ] Injected malformed output and injected timeout both leave the row at
      `status='raw'` — **never lost**
- [ ] A query with no relevant memories yields an answer that says so.
      Fabrication here is a hard failure
- [ ] Killing Ollama degrades `recall` to fused results with a warning, not an
      error
- [ ] A memory containing adversarial text ("ignore previous instructions…") does
      not alter synthesis behavior (DD-019)

---

## Phase 7 — Cache

**Goal:** Repeat reads are instant, and the cache is never wrong.

**Scope**
- `src/cache/redis.ts`: recall cache + `strata:corpus:v` counter
- Version-scoped keys including `k`, `synthesize`, `session_id` (DD-010)
- Version bump on every mutation
- Usage tracking on cache hits (DD-011)

**Out of scope:** the hot list — it is cut (DD-015). Do not build it.

**Exit criteria**
- [ ] **`recall` → `forget` → identical `recall` must not return the forgotten
      row.** This test is the phase
- [ ] **A cache hit still increments `recall_count`.** So is this one
- [ ] `k=8` and `k=50` do not share a cache entry; `synthesize:false` never
      returns a cached `answer`
- [ ] Second identical `recall` is served from cache and is dramatically faster
- [ ] Redis stopped entirely: every tool still works, warnings logged
- [ ] `FLUSHALL` costs latency only — no data loss

---

## Phase 8 — `search_by_tag`, `forget`, and compaction dry-run

**Goal:** The cheap path, the delete path, and a reviewable compaction proposal.

**Scope**
- `src/mcp/tools/searchByTag.ts`: OR by default with `match: 'all'` option,
  `limit` default, live-rows filter (DD-018)
- `src/mcp/tools/forget.ts`: **soft** delete, returns `{deleted}`, bumps corpus
  version
- `src/mcp/tools/compact.ts`: candidate selection and merge proposal,
  **dry-run only**
- Written, reviewed MCP tool descriptions for all four agent-facing tools
  (DD-018)

**Exit criteria**
- [ ] `search_by_tag` makes zero Ollama calls — verified, not assumed
- [ ] Tag queries use the GIN index (`explain` shows no sequential scan)
- [ ] `forget` on a nonexistent id returns `{deleted: false}`, not a silent
      success
- [ ] A forgotten memory never appears in any search path
- [ ] Dry-run output on the eval corpus is **reviewed by a human** and recorded
- [ ] Candidate selection uses age + `recall_count`, never `importance`
      (DD-012)
- [ ] Tool descriptions reviewed — an agent reading only the descriptions calls
      the right tool

---

## Phase 9 — Compaction execution

**Goal:** The store stays useful as it grows, reversibly.

**Scope:** enable merge writes behind `COMPACTION_ENABLED`, append-only,
depth-capped, transactional.

**Exit criteria**
- [ ] `npm run eval` recall@8 does **not regress** after a real compaction run
- [ ] Merges are append-only: inputs get `superseded_by`, nothing is deleted
- [ ] Every merge is reversible via recorded provenance — demonstrated
- [ ] `compaction_depth` never exceeds 1
- [ ] A simulated mid-merge crash leaves the group intact
- [ ] Correctness tests run against a **stubbed** instruct model on a fixed
      corpus
- [ ] Not reachable as an agent-facing MCP tool
- [ ] Disabled by default
- [ ] DD-024 resolved — a recorded judgment on whether `qwen2.5:3b` merges
      without fabricating

---

## Phase 10 — Hardening and release

**Goal:** Someone else can install and run it.

**Scope**
- README install/config with a working client config snippet
- Complete, accurate `.env.example`
- Observability pass: stage timings, one line per call, degraded-write counter,
  secrets redacted
- Optional `--http` mode: bearer token, bound to `127.0.0.1` (DD-002)

**Exit criteria**
- [ ] A clean-machine install works from the README alone, no tribal knowledge
- [ ] Every `StrataErrorCode` is reachable and maps to a sensible MCP error
- [ ] No secret appears in any log at any level
- [ ] Latency baselines recorded: cold recall, cached recall, `remember`
- [ ] A steady stream of `status='raw'` writes is visibly surfaced, not silent
