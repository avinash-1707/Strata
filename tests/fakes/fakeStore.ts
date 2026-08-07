import { randomUUID } from "node:crypto";

import { StrataError } from "../../src/errors.js";
import type {
  Enhancement,
  MemoryRecord,
  MemoryStore,
  NewMemory,
  RankedMemory,
  SearchOptions,
} from "../../src/store/types.js";

/**
 * An in-memory `MemoryStore`, for testing tool logic and its degradation paths — not
 * an imitation of Postgres. Where the two could differ (ranking quality, tsquery
 * semantics, HNSW recall) this is deliberately simple; the conformance suite run
 * against both is what proves they agree on the contract (DD-032).
 */
export interface FakeStore extends MemoryStore {
  /** Rows as stored, including non-live ones, for assertions. */
  readonly rows: readonly MemoryRecord[];
  /** Ids passed to `touchUsage`, in call order, so DD-011 is directly assertable. */
  readonly touched: readonly string[];
  /** Method names invoked, in order. */
  readonly calls: readonly (keyof MemoryStore)[];
  /**
   * Fails *every* method with `DB_QUERY_FAILED` — the "Postgres down" row of the
   * failure-mode table, where all four tools fail. Kept separate from `setFailure`
   * because failing a single method is a different row entirely (one search path
   * down, the other still serving), and the two are easy to conflate.
   */
  setDown(down: boolean): void;
  /** Makes one method reject from now on. `undefined` clears it. */
  setFailure(method: keyof MemoryStore, error: StrataError | undefined): void;
  /**
   * Blocks the named method until `release()` is called. Lets a test prove that
   * two searches run concurrently without depending on timing.
   */
  block(method: keyof MemoryStore): () => void;
  seed(rows: readonly SeedMemory[]): MemoryRecord[];
}

/** A row template. Everything but `summary` is defaulted. */
export interface SeedMemory {
  readonly id?: string;
  readonly summary: string;
  readonly rawContent?: string | null;
  readonly contentHash?: string;
  readonly status?: MemoryRecord["status"];
  readonly needsEmbedding?: boolean;
  readonly embedding?: readonly number[] | null;
  readonly embeddingModel?: string | null;
  readonly tags?: readonly string[];
  readonly sessionId?: string | null;
  readonly recallCount?: number;
  readonly compactionDepth?: number;
  readonly supersededBy?: string | null;
  readonly deletedAt?: Date | null;
  readonly createdAt?: Date;
  readonly lastRecalledAt?: Date | null;
  readonly enhancementAttempts?: number;
  readonly lastAttemptAt?: Date | null;
}

export interface FakeStoreOptions {
  readonly rows?: readonly SeedMemory[];
  readonly down?: boolean;
  /**
   * Overrides lexical ranking with a fixed id order, for tests about fusion
   * rather than about matching.
   */
  readonly lexicalRanking?: readonly string[];
  readonly semanticRanking?: readonly string[];
}

/** Fixed epoch so seeded `createdAt` values are deterministic and ordered. */
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * A deterministic but *contract-valid* default id. `memoryIdSchema` is `z.uuid()`
 * and the MCP SDK validates tool output against it, so a readable id like `seed-1`
 * fails output validation the moment the row crosses a surface. An explicit `id` is
 * still honored as given — convenient for readable assertions in tool-level tests,
 * but it must be a real UUID for any row that reaches MCP or REST.
 */
function seedUuid(index: number): string {
  const suffix = String(index + 1).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

export function createFakeStore(options: FakeStoreOptions = {}): FakeStore {
  // The embedding is held beside the record rather than on it: MemoryRecord
  // deliberately omits the vector, because no read path should ship 768 floats to
  // a tool. The fake still needs it to rank.
  const embeddings = new Map<string, readonly number[]>();
  const rows: MemoryRecord[] = [];
  const touched: string[] = [];
  const calls: (keyof MemoryStore)[] = [];
  const failures = new Map<keyof MemoryStore, StrataError>();
  const gates = new Map<keyof MemoryStore, Promise<void>>();
  const lexicalOrder = options.lexicalRanking;
  const semanticOrder = options.semanticRanking;
  let down = options.down ?? false;


  function seed(seeds: readonly SeedMemory[]): MemoryRecord[] {
    return seeds.map((seed, index) => {
      const id = seed.id ?? seedUuid(index);
      const record: MemoryRecord = {
        id,
        summary: seed.summary,
        // Not `??`: an explicit `rawContent: null` is a meaningful case (a purged
        // row), and nullish-coalescing would silently replace it with the summary —
        // making any test about absent raw content pass for the wrong reason.
        rawContent: seed.rawContent === undefined ? seed.summary : seed.rawContent,
        contentHash: seed.contentHash ?? `hash-${id}`,
        status: seed.status ?? "compressed",
        needsEmbedding: seed.needsEmbedding ?? false,
        embeddingModel: seed.embeddingModel ?? "fake-embed",
        tags: [...(seed.tags ?? [])],
        sessionId: seed.sessionId ?? null,
        // Matches the column default; nothing writes importance yet.
        importance: 3,
        recallCount: seed.recallCount ?? 0,
        compactionDepth: seed.compactionDepth ?? 0,
        supersededBy: seed.supersededBy ?? null,
        deletedAt: seed.deletedAt ?? null,
        createdAt: seed.createdAt ?? new Date(SEED_EPOCH_MS + index * 1000),
        lastRecalledAt: seed.lastRecalledAt ?? null,
        enhancementAttempts: seed.enhancementAttempts ?? 0,
        lastAttemptAt: seed.lastAttemptAt ?? null,
      };
      if (seed.embedding != null) {
        embeddings.set(id, seed.embedding);
      }
      rows.push(record);
      return record;
    });
  }

  /**
   * The single gate every read goes through, mirroring the `live_memories` view
   * the real store reads from. One helper, so DD-012's filter cannot be forgotten
   * in one method and honored in another.
   */
  function live(): MemoryRecord[] {
    return rows.filter((row) => row.supersededBy === null && row.deletedAt === null);
  }

  function replace(id: string, next: MemoryRecord): void {
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) {
      throw new Error(`fake store: no row ${id}`);
    }
    rows[index] = next;
  }

  async function enter(method: keyof MemoryStore): Promise<void> {
    calls.push(method);
    const gate = gates.get(method);
    if (gate !== undefined) {
      await gate;
    }
    if (down) {
      throw new StrataError("DB_QUERY_FAILED", `fake store is down (${method})`);
    }
    const failure = failures.get(method);
    if (failure !== undefined) {
      throw failure;
    }
  }

  function rank(
    matches: readonly MemoryRecord[],
    order: readonly string[] | undefined,
    limit: number,
    withSimilarity: boolean,
  ): RankedMemory[] {
    const ordered =
      order === undefined
        ? matches
        : order.map((id) => {
            const found = matches.find((row) => row.id === id);
            if (found === undefined) {
              // Silently dropping it would leave a fusion test quietly fusing empty
              // lists and passing for no reason.
              throw new Error(
                `fake store: ranking override names ${id}, which is not a live matching row`,
              );
            }
            return found;
          });

    return ordered.slice(0, limit).map((memory, index) => ({
      memory,
      // Strictly descending and always within (0, 1], so it behaves like a cosine
      // for ordering assertions without ever being mistaken for a measured one.
      ...(withSimilarity ? { similarity: 1 / (index + 1) } : {}),
    }));
  }

  function scoped(options: SearchOptions): MemoryRecord[] {
    const sessionId = options.sessionId;
    const candidates = live();
    return sessionId === undefined
      ? candidates
      : candidates.filter((row) => row.sessionId === sessionId);
  }

  const store: FakeStore = {
    get rows() {
      return rows;
    },
    get touched() {
      return touched;
    },
    get calls() {
      return calls;
    },

    setDown(next) {
      down = next;
    },

    setFailure(method, error) {
      if (error === undefined) {
        failures.delete(method);
      } else {
        failures.set(method, error);
      }
    },

    block(method) {
      let release = (): void => undefined;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(method, mine);
      return () => {
        // Only clear the gate if it is still ours: a second block() on the same
        // method replaced it, and deleting that one would unblock a call the test
        // still means to be holding.
        if (gates.get(method) === mine) {
          gates.delete(method);
        }
        release();
      };
    },

    seed,

    async findLiveByContentHash(contentHash) {
      await enter("findLiveByContentHash");
      return live().find((row) => row.contentHash === contentHash);
    },

    async insertRaw(memory: NewMemory) {
      await enter("insertRaw");
      const existing = live().find((row) => row.contentHash === memory.contentHash);
      if (existing !== undefined) {
        // Mirrors the partial unique index on (content_hash) over live rows that
        // migration 001 must carry (DD-032 item 11). Without that index this branch
        // would be a lie: the fake would absorb a double insert that real Postgres
        // turns into two live rows.
        return existing;
      }
      const record: MemoryRecord = {
        id: randomUUID(),
        summary: memory.summary,
        rawContent: memory.rawContent,
        contentHash: memory.contentHash,
        status: "raw",
        needsEmbedding: true,
        embeddingModel: null,
        tags: [...memory.tags],
        sessionId: memory.sessionId,
        importance: 3,
        recallCount: 0,
        compactionDepth: 0,
        supersededBy: null,
        deletedAt: null,
        createdAt: new Date(),
        lastRecalledAt: null,
        enhancementAttempts: 0,
        lastAttemptAt: null,
      };
      rows.push(record);
      return record;
    },

    async applyEnhancement(id, enhancement: Enhancement) {
      await enter("applyEnhancement");
      const current = live().find((row) => row.id === id);
      if (current === undefined) {
        // A forget landed between the durable insert and the enhancement.
        return undefined;
      }
      const embedding = enhancement.embedding;
      if (embedding !== null) {
        embeddings.set(id, embedding);
      }
      const next: MemoryRecord = {
        ...current,
        summary: enhancement.summary,
        tags: [...enhancement.tags],
        status: "compressed",
        needsEmbedding: embedding === null,
        embeddingModel: enhancement.embeddingModel,
        // DD-045: progress spends the failure history.
        enhancementAttempts: 0,
        lastAttemptAt: null,
      };
      replace(id, next);
      return next;
    },

    async searchLexical(query, options) {
      await enter("searchLexical");
      const terms = tokenize(query);
      // An empty tsquery matches nothing in Postgres; returning everything here
      // would let a whitespace-only query look like a working search.
      //
      // AND over terms, because `websearch_to_tsquery` ANDs plain words (DD-014).
      // OR-matching here made the fake match strictly more than Postgres does, and
      // recall tests were asserting that fake-only generosity.
      const matches =
        terms.length === 0
          ? []
          : scoped(options)
              .filter((row) => matchesAllTerms(row, terms))
              // Ordered by id, not insertion: every match satisfied every term, and
              // imitating ts_rank_cd would be precision the contract does not promise.
              .sort((a, b) => a.id.localeCompare(b.id));

      return rank(matches, lexicalOrder, options.limit, false);
    },

    async searchSemantic(vector, options) {
      await enter("searchSemantic");
      const matches = scoped(options)
        .map((row) => ({ row, score: cosine(vector, embeddings.get(row.id)) }))
        .filter((entry) => entry.score !== undefined)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.row.id.localeCompare(b.row.id))
        .map((entry) => entry.row);

      return rank(matches, semanticOrder, options.limit, true);
    },

    async searchByTag(tags, match, limit) {
      await enter("searchByTag");
      // Mirrors the real store's seam guard: `tags @> '{}'` would match every
      // row, and later phases call the store without the tool schema in front.
      if (tags.length === 0) {
        return [];
      }
      const wanted = new Set(tags);
      return live()
        .filter((row) =>
          match === "all"
            ? [...wanted].every((tag) => row.tags.includes(tag))
            : row.tags.some((tag) => wanted.has(tag)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async touchUsage(ids) {
      await enter("touchUsage");
      const now = new Date();
      for (const id of ids) {
        touched.push(id);
        const current = live().find((row) => row.id === id);
        if (current !== undefined) {
          replace(id, { ...current, recallCount: current.recallCount + 1, lastRecalledAt: now });
        }
      }
    },

    async softDelete(id) {
      await enter("softDelete");
      const current = live().find((row) => row.id === id);
      if (current === undefined) {
        return false;
      }
      replace(id, { ...current, deletedAt: new Date() });
      return true;
    },

    async restore(id) {
      await enter("restore");
      // Searches `rows`, not `live()`: the row being restored is by definition not live.
      const current = rows.find(
        (row) => row.id === id && row.deletedAt !== null && row.supersededBy === null,
      );
      if (current === undefined) {
        return false;
      }
      // Mirrors memories_hash_live_idx. Reachable exactly because that index is
      // partial: forget X, remember the same content, then try to restore X. Real
      // Postgres raises 23505 here, so returning true would make recovery a 503 in
      // Phase 4 while every test still passed.
      if (live().some((row) => row.contentHash === current.contentHash)) {
        return false;
      }
      replace(id, { ...current, deletedAt: null });
      return true;
    },

    async findEnhancementBacklog(limit, policy) {
      await enter("findEnhancementBacklog");
      const now = Date.now();
      return live()
        .filter((row) => row.status === "raw" || row.needsEmbedding)
        // DD-041: without this, a row that always fails holds its slot forever and
        // starves everything behind it, because the order below is by age.
        .filter((row) => row.enhancementAttempts < policy.maxAttempts)
        // DD-045: exponential backoff, so a failing row does not spend its whole cap
        // inside a few minutes of consecutive passes.
        .filter(
          (row) =>
            row.lastAttemptAt === null ||
            row.lastAttemptAt.getTime() + policy.retryBaseMs * 2 ** row.enhancementAttempts <= now,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit);
    },

    async recordEnhancementAttempt(id) {
      await enter("recordEnhancementAttempt");
      // Searches `rows`, not `live()`: an attempt may be recorded against a row a
      // concurrent forget has just removed, and losing the increment is worse than
      // stamping a dead row.
      const current = rows.find((row) => row.id === id);
      if (current !== undefined) {
        replace(id, {
          ...current,
          enhancementAttempts: current.enhancementAttempts + 1,
          lastAttemptAt: new Date(),
        });
      }
    },
  };

  if (options.rows !== undefined) {
    seed(options.rows);
  }

  return store;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
}

function matchesAllTerms(row: MemoryRecord, terms: readonly string[]): boolean {
  const haystack = `${row.summary} ${row.rawContent ?? ""}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function cosine(a: readonly number[], b: readonly number[] | undefined): number | undefined {
  if (b === undefined) {
    return undefined;
  }
  if (a.length !== b.length) {
    // pgvector *errors* on a width mismatch rather than skipping the row. Silently
    // dropping it here would let a Phase 3 path pass and then fail in Phase 4.
    throw new StrataError(
      "EMBEDDING_DIM_MISMATCH",
      `query vector has ${String(a.length)} dimensions, stored vector has ${String(b.length)}`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [index, valueA] of a.entries()) {
    const valueB = b[index] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
