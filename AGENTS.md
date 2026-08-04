# AGENTS.md

Strata is a local-first MCP server giving AI agents compressed, searchable
memory. Node 20 + TypeScript, Postgres + pgvector, Redis, Ollama. Single user,
single host, no external API calls.

## Which document wins

`docs/` is authoritative. `context.md` is the original spec and is **known to
contain four critical defects** that `docs/` corrects — including a write path
that can lose memories and a `forget` that doesn't forget. Where the two differ,
follow `docs/` and the referenced `DD-0NN`. Never implement `context.md`
verbatim.

## Read only what the task needs

Do not load any document wholesale. Load the narrowest set that covers the task:

| Task | Read |
| --- | --- |
| Writing or changing any code in `src/` | `docs/coding-standards.md` |
| Adding/changing a tool, module, or data flow | `docs/architecture.md` + `docs/coding-standards.md` |
| "What do I build next?" | `docs/build-plan.md` (current phase only) + `docs/progress-tracker.md` (Current state block only) |
| Database schema, migrations, indexes | `docs/architecture.md` § Data model |
| Search, ranking, or fusion work | `docs/architecture.md` § Retrieval pipeline |
| Prompts, LLM parsing, Ollama calls | `docs/architecture.md` § Model layer |
| Docker, Compose, env vars, deployment | `docs/architecture.md` § Runtime topology |
| "Why is it done this way?" / proposing a change to a settled choice | `docs/design-decisions.md` |
| Onboarding, scope questions, "should we build X?" | `docs/project-overview.md` |
| Reviewing or finishing someone else's work | `docs/progress-tracker.md` (Current state) + the phase's entry in `docs/build-plan.md` |

Rules for reading:

- Read `docs/progress-tracker.md`'s **Current state** block only. The Log below
  it is history — skip it unless you need to know why something changed.
- Read only the **current phase** of `docs/build-plan.md`, not all phases.
- Consult `context.md` only when a doc contradicts itself or omits a spec detail.

## Always applies

These hold for every code change. Details in `docs/coding-standards.md`.

1. Strict TypeScript. No `any` at any module boundary. `unknown` + validate for
   `JSON.parse`, env vars, LLM output, and caught errors.
2. `src/db`, `src/cache`, `src/ollama` never import each other. Composition
   happens in `src/mcp/tools/*`.
3. No business logic in `src/mcp/server.ts` — registration and wiring only.
4. Every external call: wrapped in try/catch, given a timeout, surfaced as a
   `StrataError` with a specific code. Never swallow an error.
5. Never lose a write. `remember`'s durable insert commits before any model call
   and fails loud; compression/embedding degrade to `status:'raw'`. Cache and
   synthesis failures must still serve a useful result (DD-005).
6. Every read filters `superseded_by is null and deleted_at is null` (DD-012).
7. Logging goes to **stderr** — stdout is the MCP protocol channel (DD-002).
8. Parameterized SQL only. No `select *`. Never assume a row exists.
9. Named constants with a justifying comment instead of magic numbers.
10. Don't build for non-goals: no multi-user, no scale-out, no cloud. See
    `docs/project-overview.md`.

## Before you finish

- `tsc --noEmit` and lint must be clean. Pure logic needs unit tests.
- Architectural, schema, contract, or dependency change → update the
  **Current state** block in `docs/progress-tracker.md` and add a Log entry.
- Made a non-obvious choice, or resolved an `Open` question → add an entry to
  `docs/design-decisions.md` and reference its `DD-00N` id in a code comment.
- Completed a build-plan phase → tick its exit criteria; do not tick criteria
  you have not actually verified by running something.

## Don't

- Don't re-derive a decision recorded in `docs/design-decisions.md`. If you
  disagree, propose a superseding entry — don't silently implement the opposite.
- Don't add dependencies not in the stack without recording a decision.
- Don't mark work done based on intent. Run the check.
- Don't expand scope mid-phase. Note it and move on.
