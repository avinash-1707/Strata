# Source layout

The shape of this directory is the shape of the dependency graph. Nothing lower imports
anything higher, and several of the boundaries below are enforced by lint rules rather
than left to reviewer memory.

```
config/     environment and budgets      (imports nothing)
errors.ts   the one error type
logger.ts   stderr-only structured logs
tags.ts     hash.ts   shutdown.ts        pure helpers

contracts/  Zod schemas for every wire type, shared by both surfaces
search/     reciprocal rank fusion, pure

store/      MemoryStore interface  ->  store/pg, the only place SQL lives
cache/      recall cache interface ->  cache/redis.ts
ollama/     model client, prompts, output parsing
db/         connection pool, migrations, advisory locks

tools/      domain logic, surface-agnostic, contains no SQL
jobs/       the background repair pass

mcp/        MCP surface: server, stdio, MCP over HTTP
http/       REST surface: Hono app, auth, routes, listener

deps.ts     ToolDeps, the contract between the root and every surface
main.ts     the composition root
```

## Dependency direction

```
surfaces  ->  tools  ->  search  ->  store, cache, ollama  ->  config
```

Read it strictly. A search module may never import a tool. Shared types live in leaf
modules that import nothing.

## The seams, and what each prevents

Five boundaries matter enough to be enforced. A script plants a deliberately illegal
import at every one of them and fails if the linter allows it through.

**The three infrastructure clients may not import each other.** `db`, `cache`, and
`ollama` are mutually isolated, so any one of them can be replaced without touching the
other two. Composition happens one level up, in `tools`.

**The store receives a query vector, never an embedder.** It would be convenient for
semantic search to embed its own query. Allowing it is exactly how the isolation above
collapses, so `MemoryStore` takes `readonly number[]` and has no idea a model exists.

**The domain layer may not import a surface.** `tools` is called by both MCP and REST
and depends on neither. This is what keeps the two surfaces from drifting: there is
only one implementation of anything either of them can do.

**Neither surface may import the other.** `http` cannot reach into `mcp`, which is why
the MCP request handler is injected into the Hono app as a plain function rather than
imported by it.

**No production module may import a test fake.** `tests/` is outside the build, so this
one fails at runtime rather than at compile time, which is the worst place to find out.

`main.ts` is the single exception. It is the composition root, it is allowed to name
every layer because assembling them is its entire job, and it still may not import a
fake.

## Where the logic lives

`tools/` holds the four agent-facing operations plus the shared enhancement stage.
These functions take validated input and a dependency bundle, and return contract
values. They perform no SQL, know nothing about HTTP status codes, and are the reason
both surfaces behave identically.

`mcp/server.ts` and `http/app.ts` are wiring only. If an `if` statement about memory
content appears in either, it belongs in `tools/`.

`store/pg/` is the only directory permitted to contain SQL. Queries are parameterised,
name their columns explicitly rather than selecting everything, and never assume a row
came back.

## Errors

One error type, tagged by code, carrying the original failure as its cause.

- Every external call is wrapped, given a timeout, and converted at the client module.
  The underlying error is never discarded.
- Nothing is swallowed. An empty catch block is a lint error. An ignorable failure is
  logged at debug with a comment explaining why it is ignorable.
- Writes fail loud; enhancement degrades. The durable insert in `remember` propagates
  its failure, because silently losing a memory is the worst outcome this system has.
  The compression and embedding that follow it degrade to a raw status and a warning,
  because the memory is already safe.
- Empty is not broken. Zero search results is a successful response carrying an empty
  array.
- The map from error code to HTTP status is an exhaustive record. Adding a code fails
  to compile until its status is chosen, so a new failure mode cannot quietly become a
  500.

## Logging

All logs go to stderr. Under the stdio transport, stdout is the MCP protocol channel,
and a stray write corrupts the JSON-RPC stream in a way that surfaces to the user as a
client bug. `no-console` is a lint error across the whole of `src`, which is what
actually keeps that from happening.

Each tool call emits exactly one structured line, carrying its outcome, duration, and
whatever counters that particular tool produced. Full error causes go to stderr only;
response bodies carry an authored public message, because a wrapped cause can contain
statement text, parameter values, and connection credentials.

## Configuration and constants

`config/env.ts` holds what an operator sets. `config/budgets.ts` holds time and size
limits that are properties of the design rather than of a deployment. Keeping both in
one module hid which was which.

There are no bare numbers in this codebase. Every constant is named and carries a
comment stating why that value and not another, and where the value is a reasoned guess
rather than a measurement, the comment says so.
