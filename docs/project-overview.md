# Project Overview

> Read this when you need orientation on *what* Strata is and *why* it exists.
> For *how* it is built, read [architecture.md](./architecture.md).

## The problem

AI coding agents lose context between sessions. Every new session re-explains
decisions, architecture, and debugging that already happened. Existing memory
tools fail in one of two ways:

- **Raw transcript dumps.** Cheap to write, useless to read back. The store
  becomes a junk drawer and retrieval quality decays as it grows.
- **Hosted services.** Your project's decision history, code discussion, and
  internal architecture leave your machine and land in someone else's database.

## What Strata is

A local MCP server that gives any MCP-compatible agent durable, compressed,
semantically searchable memory. It runs entirely on hardware you own — no
external API calls, no data leaving the host, no per-token cost.

Two ideas define it:

1. **Compress on write, synthesize on read.** A small local instruct model
   distills raw input into durable facts on the way in, and reasons over a short
   retrieved shortlist on the way out. Memory is *distilled knowledge*, not
   transcript.
2. **Cheap before expensive.** Retrieval escalates through stages — cache, then
   lexical, then vector, then fusion, then LLM synthesis — so the expensive
   stages only ever see a small candidate set. Latency stays bounded as the
   store grows.

## What Strata is not

These are hard non-goals. Do not build them, and do not design for them
"just in case" — speculative generality here is a cost with no payoff.

| Non-goal | Consequence for design |
| --- | --- |
| Multi-user | No tenant column, no per-user auth, no row-level security |
| Real-time collaboration | No websockets, no CRDTs, no live sync |
| Verbatim transcript storage | `raw_content` is an audit/recovery field, not the primary read path |
| Cloud/hosted deployment | Single-host assumptions are fine; localhost is a valid bind address |
| Horizontal scale | Single Postgres, single Redis, single Ollama. No sharding, no read replicas |

Single user, single host. Optimize for that.

## Domain vocabulary

Use these terms consistently in code, comments, and commits.

| Term | Meaning |
| --- | --- |
| **memory** | One row in `memories`. A single distilled fact or decision |
| **summary** | The compressed, durable form of an input. The only text that is *embedded* |
| **raw_content** | The original unprocessed input. Full-text indexed, never embedded |
| **compression** | Instruct-model pass on the write path: raw input → `{summary, suggested_tags}` |
| **synthesis** | Instruct-model pass on the read path: query + candidates → one coherent answer |
| **lexical search** | Postgres full-text search over `summary_tsv` (covers summary *and* raw content) |
| **semantic search** | pgvector similarity over `embedding` |
| **fusion** | Reciprocal Rank Fusion merging the lexical and semantic ranked lists |
| **recall cache** | Redis entry holding a whole `recall` result, keyed by corpus version + query |
| **raw / compressed** | A memory's `status`. `raw` = durably stored but not yet compressed |
| **compaction** | Scheduled append-only merge of stale, never-recalled memories into one higher-level memory |

## Agent-facing surface

Four tools are exposed to agents. `compact` is a scheduled job, never callable
by an agent.

| Tool | Cost | Purpose |
| --- | --- | --- |
| `remember` | 1 SQL, then best-effort 1 LLM + 1 embed | Store a new memory |
| `recall` | 0–1 LLM + 0–1 embed call | Retrieve and optionally synthesize an answer |
| `search_by_tag` | 1 SQL query | Cheapest possible lookup, exact tag filter |
| `forget` | 1 SQL query | Soft-delete a memory by id |

`remember` commits the memory to Postgres *before* calling any model, so a model
outage degrades the write instead of losing it. Exact input/output contracts live
in [architecture.md](./architecture.md).

## What "done" means

Strata is working when all of the following hold:

- A real MCP client (Claude Code, Cursor, Claude Desktop) can connect, write a
  memory, and read it back in a later session with a fresh context window.
- `recall` returns a useful answer for a query that shares *no literal keywords*
  with the stored memory — proving the semantic path works, not just FTS.
- `recall` returns a useful answer for an exact identifier (an error code, a
  function name) — proving the lexical path works, not just vectors.
- A cold `recall` with synthesis stays under a few seconds on the target
  hardware; a cached `recall` is effectively instant.
- Postgres and Redis come up from `docker compose up` on a machine that has never
  run it before, with no manual steps beyond setting `.env`. (Ollama runs on the
  host — see design decision DD-007.)
- Killing Ollama degrades the system rather than corrupting it: writes still land
  durably as uncompressed memories, and reads keep working without synthesis.
- A memory that was forgotten never reappears — not from a search path, and not
  from a cached answer.
- Retrieval quality is a *number*, not an impression: `npm run eval` reports
  recall@8, and hybrid search measurably beats semantic-only.

## Reading order for a new contributor

1. This document
2. [architecture.md](./architecture.md) — components, data flow, contracts
3. [coding-standards.md](./coding-standards.md) — how code must be written here
4. [build-plan.md](./build-plan.md) — what to build next, in what order
5. [design-decisions.md](./design-decisions.md) — why things are the way they are
