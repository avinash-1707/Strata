# Progress Tracker

> **Agents: read only the "Current state" block below unless you need history.**
> Everything under "Log" is append-only history and is usually irrelevant to the
> task at hand. Do not read it into context without a reason.

---

## Current state

**Phase:** 0 — Documentation baseline · **complete**
**Next phase:** 1 — Model truth-finding
**Last updated:** 2026-08-04

### What exists

- `README.md`, `LICENSE` (MIT), `context.md` (original spec)
- `AGENTS.md` — context routing rules for coding agents
- `docs/` — project overview, architecture, coding standards, build plan, this
  tracker, and 24 recorded design decisions

### What does not exist yet

- No `src/`, no `eval/`, no `package.json`, no `tsconfig.json`
- No `docker-compose.yml`, no `.env.example`
- No migrations, no database
- Zero runnable code

### Immediate next step

Phase 1 in [build-plan.md](./build-plan.md) — model truth-finding. A throwaway
script against Ollama producing `docs/model-findings.md`. **No application code
in this phase.** It exists because DD-008 (embedding task prefixes) is unfixable
later without re-embedding the whole corpus.

### Load-bearing invariants

Violating any of these is a defect, not a style question:

1. **stdout is the MCP protocol channel.** All logging goes to stderr (DD-002).
2. **`remember` never loses a memory.** The durable insert commits before any
   model call (DD-005).
3. **Every read filters `superseded_by is null and deleted_at is null`**
   (DD-012).
4. **Embedding prefixes are applied in one place, conditional on model family**
   (DD-008).
5. **Cache keys include the corpus version, `k`, and `synthesize`** (DD-010).
6. **Cache hits still record usage** (DD-011).

### Known open questions

- DD-023 — near-duplicate cosine threshold (needs real data)
- DD-024 — whether `qwen2.5:3b` is adequate for compaction (resolve at Phase 9)

---

## How to update this file

Update **Current state** on every change that alters what exists or what comes
next. Keep it short — it is read constantly, so every extra line costs context
on every future task.

Add a **Log** entry only for: completing a phase, an architectural change, a
schema change, a dependency added or removed, or a reversal of a previous
decision.

Do **not** log routine implementation of already-planned work, formatting,
comment edits, or tests that do not change behavior.

### Entry format

```markdown
### YYYY-MM-DD — Short title

**Type:** phase-complete | architecture | schema | dependency | reversal
**Phase:** N

What changed, in two or three sentences. State the observable difference, not
the process.

**Files:** the files that materially changed
**Verified by:** the command or check that proves it works
**Decisions:** DD-00N (if any were recorded)
```

Newest entries at the **top**.

---

## Log

### 2026-08-04 — Spec review corrected four critical defects before implementation

**Type:** architecture
**Phase:** 0

A pre-implementation review of `context.md` found four critical defects, now
amended in `docs/architecture.md` and recorded as decisions:

- **`remember` could lose memories.** Compress → embed → insert with
  `embedding not null` meant an Ollama outage made the insert impossible while
  the calling agent moved on. The write path is now durable-first (DD-005).
- **`forget` did not forget.** The recall cache had no invalidation, so a
  deleted memory could be served from cache — including inside a synthesized
  answer. Cache keys are now corpus-version-scoped (DD-010).
- **Embedding prefixes were missing.** `nomic-embed-text` requires
  `search_document:`/`search_query:` prefixes; omitting them degrades retrieval
  silently and is unfixable without a full re-embed (DD-008).
- **Compaction was destructive with an inoperable predicate.** It selected on
  `importance`, which no tool writes, so it matched the entire corpus; and its
  recency signal was suppressed by cache hits. Compaction is now append-only,
  age-and-usage based, dry-run first, off by default (DD-011, DD-012).

Also changed: stdio replaces HTTP as the primary transport (DD-002); Ollama runs
on the host rather than in Compose (DD-007); FTS covers `raw_content` while
embeddings stay summary-only (DD-004); `websearch_to_tsquery` replaces
`to_tsquery`, which throws on natural-language input (DD-014); migrations are
authoritative and `schema.sql` is dropped (DD-013); the unread Redis hot list is
cut (DD-015).

**Files:** `docs/architecture.md`, `docs/build-plan.md`, `docs/design-decisions.md`
**Verified by:** N/A — documentation only. Every amendment is gated by a phase
exit criterion in `build-plan.md`
**Decisions:** DD-001 through DD-024

### 2026-08-04 — Documentation baseline established

**Type:** phase-complete
**Phase:** 0

Created the `docs/` set and a root `AGENTS.md` that routes coding agents to the
minimum relevant document per task type instead of loading the whole spec on
every request. `context.md` remains the original spec; `docs/` is the maintained
layer and is authoritative where the two differ.

Build order was restructured around two gates that the original spec lacked:
model behavior is verified before any code depends on it (DD-022), and retrieval
quality is measured by an eval harness that later phases must beat (DD-021).

**Files:** `AGENTS.md`, `docs/project-overview.md`, `docs/architecture.md`,
`docs/coding-standards.md`, `docs/build-plan.md`, `docs/progress-tracker.md`,
`docs/design-decisions.md`
**Verified by:** N/A — documentation only
**Decisions:** DD-021, DD-022
