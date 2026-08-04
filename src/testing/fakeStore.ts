import type { StrataError } from "../errors.js";
import type {
  Enhancement,
  MemoryRecord,
  MemoryStore,
  NewMemory,
  RankedMemory,
  SearchOptions,
} from "../store/types.js";

/**
 * An in-memory `MemoryStore`. Its purpose is to make the *tool* logic testable —
 * degradation paths especially — not to imitate Postgres. Where the two could
 * differ (ranking quality, tsquery semantics, HNSW recall), the fake is
 * deliberately simple; the store conformance suite is what proves the fake and
 * Postgres agree on the contract, and it runs against both (DD-032).
 */
export interface FakeStore extends MemoryStore {
  /** Rows as stored, including non-live ones, for assertions. */
  readonly rows: readonly MemoryRecord[];
  /** Ids passed to `touchUsage`, in call order, so DD-011 is directly assertable. */
  readonly touched: readonly string[];
  /** Method names invoked, in order. */
  readonly calls: readonly (keyof MemoryStore)[];
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
}

export interface FakeStoreOptions {
  readonly rows?: readonly SeedMemory[];
  /**
   * Overrides lexical ranking with a fixed id order, for tests about fusion
   * rather than about matching.
   */
  readonly lexicalRanking?: readonly string[];
  readonly semanticRanking?: readonly string[];
}

/** Fixed epoch so seeded `createdAt` values are deterministic and ordered. */
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

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
  let nextId = 1;

  function seed(seeds: readonly SeedMemory[]): MemoryRecord[] {
    return seeds.map((seed, index) => {
      const id = seed.id ?? `seed-${String(index + 1)}`;
      const record: MemoryRecord = {
        id,
        summary: seed.summary,
        rawContent: seed.rawContent ?? seed.summary,
        contentHash: seed.contentHash ?? `hash-${id}`,
        status: seed.status ?? "compressed",
        needsEmbedding: seed.needsEmbedding ?? false,
        embeddingModel: seed.embeddingModel ?? "fake-embed",
        tags: [...(seed.tags ?? [])],
        sessionId: seed.sessionId ?? null,
        importance: 3,
        recallCount: seed.recallCount ?? 0,
        compactionDepth: seed.compactionDepth ?? 0,
        supersededBy: seed.supersededBy ?? null,
        deletedAt: seed.deletedAt ?? null,
        createdAt: seed.createdAt ?? new Date(SEED_EPOCH_MS + index * 1000),
        lastRecalledAt: seed.lastRecalledAt ?? null,
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
        : order
            .map((id) => matches.find((row) => row.id === id))
            .filter((row): row is MemoryRecord => row !== undefined);

    return ordered.slice(0, limit).map((memory, index) => ({
      memory,
      rank: index + 1,
      // Descending and bounded, so a caller cannot mistake it for a real cosine.
      ...(withSimilarity ? { similarity: 1 - index * 0.05 } : {}),
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

    setFailure(method, error) {
      if (error === undefined) {
        failures.delete(method);
      } else {
        failures.set(method, error);
      }
    },

    block(method) {
      let release = (): void => undefined;
      gates.set(
        method,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(method);
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
        // Mirrors the real store's `on conflict`-style idempotency (DD-020); a
        // fake that happily inserted a duplicate would hide that bug.
        return existing;
      }
      const record: MemoryRecord = {
        id: `mem-${String(nextId++)}`,
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
      };
      replace(id, next);
      return next;
    },

    async searchLexical(query, options) {
      await enter("searchLexical");
      const terms = tokenize(query);
      // An empty tsquery matches nothing in Postgres; returning everything here
      // would let a whitespace-only query look like a working search.
      const matches =
        terms.length === 0
          ? []
          : scoped(options)
              .map((row) => ({ row, hits: countHits(row, terms) }))
              // Ties broken by id, not insertion order, so ranking is stable.
              .sort((a, b) => b.hits - a.hits || a.row.id.localeCompare(b.row.id))
              .filter((entry) => entry.hits > 0)
              .map((entry) => entry.row);

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

    async claimEnhancementBacklog(limit) {
      await enter("claimEnhancementBacklog");
      return live()
        .filter((row) => row.status === "raw" || row.needsEmbedding)
        .slice(0, limit);
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

function countHits(row: MemoryRecord, terms: readonly string[]): number {
  const haystack = `${row.summary} ${row.rawContent ?? ""}`.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

function cosine(a: readonly number[], b: readonly number[] | undefined): number | undefined {
  if (b === undefined || a.length !== b.length) {
    return undefined;
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
