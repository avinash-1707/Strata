# Coding Standards

> Read this before writing or modifying any code in `src/`.
> These are rules, not suggestions. Where a rule has a stated exception, the
> exception is the only permitted deviation.

## 1. TypeScript configuration

`tsconfig.json` must enable at minimum:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,   // arr[0] is T | undefined
    "exactOptionalPropertyTypes": true, // {a?: string} ≠ {a: string | undefined}
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

`noUncheckedIndexedAccess` is non-negotiable. Database rows and LLM-parsed
arrays are the two biggest sources of runtime `undefined` in this codebase, and
both arrive through index access.

## 2. The `any` rule

`any` is banned at every module boundary — exported function signatures, tool
inputs and outputs, database row types, HTTP payloads.

Inside a function body, prefer `unknown` and narrow:

```ts
// Bad — defeats the type system at the exact point it matters
const parsed = JSON.parse(raw) as CompressionResult;

// Good — unknown forces validation before use
const parsed: unknown = JSON.parse(raw);
const result = compressionResultSchema.parse(parsed);
```

`unknown` is always the correct type for: `JSON.parse` output, LLM responses,
caught errors, and `process.env` values before validation.

## 3. Validate at the boundary, trust internally

Every value crossing into the system gets parsed once, at the edge, into a
domain type. After that boundary, code trusts its types and does not re-check.

The three boundaries are:

1. **MCP tool inputs** — validated by the tool's schema
2. **Environment variables** — validated once in `src/config.ts` at startup
3. **LLM responses** — validated after `JSON.parse`, because a 3B model will
   eventually return malformed output

```ts
// src/config.ts — fail at startup, not at first use
const envSchema = z.object({
  POSTGRES_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  OLLAMA_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(1),
  INSTRUCT_MODEL: z.string().min(1),
  MCP_AUTH_TOKEN: z.string().min(16),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return Object.freeze(result.data);
}
```

A misconfigured server must refuse to start. It must never start and then fail
on the first tool call, because that failure surfaces to the agent as a
confusing tool error instead of an obvious boot failure.

## 4. Module boundaries

Three infrastructure clients exist, and they are **mutually isolated**:

```
src/db/client.ts      →  imports pg, config          (never redis, never ollama)
src/cache/redis.ts    →  imports redis, config       (never pg, never ollama)
src/ollama/client.ts  →  imports fetch, config       (never pg, never redis)
```

No infrastructure module may import another. Any one of the three must be
replaceable without touching the other two. Composition happens one level up,
in `src/mcp/tools/*`.

Dependency direction is strictly one-way:

```
server.ts  →  tools/*  →  search/*  →  db, cache, ollama  →  config
```

Nothing lower imports from anything higher. A search module must never import a
tool. If you need shared types, they go in a leaf module that imports nothing.

### `server.ts` contains no logic

`server.ts` wires up the MCP server and registers tools. That is all. If you
find yourself writing an `if` statement about memory content in `server.ts`, it
belongs in `src/mcp/tools/`.

## 5. Dependency injection over module-level singletons

Do not create clients at import time. A module that connects on import cannot
be tested and cannot fail gracefully.

```ts
// Bad — connects on import, untestable, throws during module resolution
export const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

// Good — explicit construction, injectable, testable
export interface Db {
  query<R extends QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
}

export function createDb(config: Config): Db {
  const pool = new Pool({ connectionString: config.POSTGRES_URL });
  return {
    async query<R extends QueryResultRow>(sql, params) {
      try {
        const { rows } = await pool.query<R>(sql, params);
        return rows;
      } catch (cause) {
        throw new StrataError("DB_QUERY_FAILED", "Database query failed", { cause });
      }
    },
    close: () => pool.end(),
  };
}
```

Tools receive their dependencies as an explicit argument:

```ts
export interface ToolDeps {
  readonly db: Db;
  readonly cache: Cache;
  readonly ollama: Ollama;
  readonly config: Config;
}

export async function remember(
  input: RememberInput,
  deps: ToolDeps,
): Promise<RememberOutput> { /* ... */ }
```

This makes every tool unit-testable with fakes and makes the dependency graph
of each tool visible in its signature.

## 6. Error handling

### One error type, tagged by code

```ts
export type StrataErrorCode =
  | "CONFIG_INVALID"
  | "DB_QUERY_FAILED"
  | "CACHE_UNAVAILABLE"
  | "OLLAMA_UNAVAILABLE"
  | "OLLAMA_BAD_RESPONSE"
  | "EMBEDDING_DIM_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_INPUT";

export class StrataError extends Error {
  constructor(
    readonly code: StrataErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, { cause: options?.cause });
    this.name = "StrataError";
    this.details = options?.details;
  }
  readonly details?: Record<string, unknown>;
}
```

### Rules

- **Wrap every external call.** Postgres, Redis, and Ollama calls are wrapped at
  the client module, converted to a `StrataError` with a specific code, and the
  original error is preserved via `cause`. Never lose the underlying error.
- **Never swallow.** `catch {}` with an empty body is banned. If an error is
  genuinely ignorable, log it at `debug` and write a comment explaining why.
- **Never lose a write; degrade everything else.** The precise rule (DD-005): the
  *durable insert* in `remember` fails loud, because silently losing a memory is
  the worst outcome in this system. The *enhancement* that follows it —
  compression, embedding — degrades to `status: 'raw'` and a warning, because the
  memory is already safe. Optional read steps (cache, synthesis) likewise degrade
  to the next-best result.

  Do not simplify this to "writes fail loud." Failing the whole `remember` call
  because Ollama was slow is the bug DD-005 exists to prevent.
- **Distinguish "broken" from "empty".** Zero search results is a successful
  response with an empty array, not an error.

### Degradation is explicit, not accidental

```ts
// Cache is an optimization. Its failure must not fail the request.
let cached: RecallOutput | undefined;
try {
  cached = await deps.cache.getRecall(queryHash);
} catch (error) {
  deps.log.warn({ error }, "recall cache read failed, continuing uncached");
}
if (cached) return cached;
```

Contrast with Ollama on the write path, where failure is fatal to the operation
and must propagate.

## 7. Async discipline

- No floating promises. Every promise is awaited, returned, or explicitly
  handled with `.catch()`. Enable `@typescript-eslint/no-floating-promises`.
- Independent I/O runs concurrently. The lexical and semantic searches in
  `recall` do not depend on each other:

  ```ts
  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query, deps),
    semanticSearch(query, deps),
  ]);
  ```

  Sequential `await`s for independent work is a bug, not a style choice.
- Every external call has a timeout. Ollama especially — a stuck generation must
  not hang a tool call forever. Use `AbortSignal.timeout(ms)`.
- Use `Promise.allSettled` when partial failure is acceptable (e.g. one of two
  search paths failing should still allow fusion over the survivor).

## 8. SQL

- **Always parameterized.** Never interpolate a value into SQL, including
  `LIMIT`. If a dynamic identifier is unavoidable, validate it against an
  allow-list first.
- Keep SQL in the module that owns it (`src/search/lexical.ts` owns the FTS
  query). No SQL in tool files.
- Type the row shape explicitly and never assume a row exists:

  ```ts
  interface MemoryRow {
    readonly id: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly score: number;
  }
  const rows = await deps.db.query<MemoryRow>(sql, [query, limit]);
  const first = rows[0];            // MemoryRow | undefined
  if (!first) return { results: [] };
  ```
- `select *` is banned. Name columns explicitly so a schema change causes a
  compile-time or query-time failure rather than silently changing behavior.

## 9. Naming and file conventions

| Thing | Convention | Example |
| --- | --- | --- |
| Files | `camelCase.ts` | `searchByTag.ts` |
| Types / interfaces / classes | `PascalCase` | `RecallInput` |
| Functions / variables | `camelCase` | `fuseRankings` |
| Constants | `UPPER_SNAKE_CASE` | `RRF_K` |
| MCP tool names (wire) | `snake_case` | `search_by_tag` |
| DB columns | `snake_case` | `last_recalled_at` |

The wire/DB boundary uses `snake_case`; TypeScript uses `camelCase`. Map
explicitly at the boundary — do not leak `snake_case` field names through
internal types, and do not rename MCP tool inputs that are part of the public
contract.

No magic numbers. `60`, `50`, `20`, `8` all appear in this system's spec and all
must be named constants with a comment stating *why* that value:

```ts
/** RRF dampening constant. 60 is the value from the original TREC paper. */
export const RRF_K = 60;
```

## 10. Immutability

- `readonly` on interface fields that are not meant to be reassigned.
- Prefer `readonly T[]` for parameters you do not mutate.
- Never mutate a function argument. Return a new value.
- Config is frozen at load.

## 11. Logging and observability

**All logging goes to stderr. stdout is the MCP protocol channel** (DD-002). A
single `console.log` anywhere in the process corrupts the JSON-RPC stream and
presents as a client-side bug. `console.log` is therefore banned outright —
enforce it with a lint rule, not vigilance.

Use structured logging (`pino`) configured to write to `stderr`.

- One log line per tool invocation with: tool name, duration, outcome, and the
  cheap identifying facts (result count, cache hit/miss). Never log full memory
  content at `info` — it is user data.
- Log the *stage timings* of `recall` (cache, lexical, semantic, fusion,
  synthesis) at `debug`. Without this, latency regressions are undiagnosable.
- Levels: `error` = operation failed; `warn` = degraded but served; `info` =
  normal operation; `debug` = stage detail.
- Redact secrets. `MCP_AUTH_TOKEN` and connection strings must never appear in
  logs.

## 12. Testing

| Layer | What to test | Dependencies |
| --- | --- | --- |
| Pure logic (`fusion.ts`, prompt builders) | Unit tests, exhaustive edge cases | None — must be pure |
| Tool logic | Behavior with faked `ToolDeps` | Fakes, not mocks of `pg` internals |
| Search modules | Real queries against a test Postgres | Testcontainers or a disposable compose service |
| End-to-end | Real MCP client against the running stack | Full compose stack |

Non-negotiable test cases:

- `fusion.ts` with: empty lexical list, empty semantic list, both empty, full
  overlap, zero overlap, single-item lists. Fusion is pure and cheap to test,
  and a bug here silently degrades all retrieval quality.
- Malformed LLM output: fenced JSON, prose-wrapped JSON, truncated JSON, valid
  JSON with wrong field names. The compression parser must handle all of these
  deterministically.
- Zero-result recall.
- Every `StrataErrorCode` is reachable and produces a sensible MCP error.

Keep pure logic pure specifically so it can be tested without infrastructure.
If a function needs a database to test, ask whether its logic could be
extracted.

## 13. Comments

Comment *why*, never *what*. The code states what it does.

```ts
// Bad
// Loop over the results and add them to the map
// Good
// Lexical and semantic lists can both contain the same id, so accumulate
// instead of assigning — RRF sums contributions across rankers.
```

Any deviation from these standards, or any non-obvious constant, gets a comment
pointing at the design decision that justifies it:

```ts
// Embedding the summary only, never raw_content — see DD-004.
```

## 14. Definition of done for any code change

Before considering work complete:

- [ ] `tsc --noEmit` clean
- [ ] Lint clean, no disabled rules without a justifying comment
- [ ] New pure logic has unit tests; new tool logic has a test with fake deps
- [ ] No `any`, no floating promises, no empty catch blocks
- [ ] External calls have timeouts and produce `StrataError` on failure
- [ ] If the change alters architecture or a contract:
      [progress-tracker.md](./progress-tracker.md) updated
- [ ] If the change makes a non-obvious choice:
      [design-decisions.md](./design-decisions.md) entry added
