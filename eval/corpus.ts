/**
 * The seeded eval corpus (DD-021). Fixed, hand-authored, and deliberately hostile
 * to each retrieval arm in turn — a corpus of unrelated notes would score ~1.0 on
 * anything and measure nothing.
 *
 * Three properties make the numbers mean something, and `tests/eval/corpus.test.ts`
 * enforces all three mechanically rather than trusting this comment:
 *
 * 1. **Clusters are larger than `k`.** Twelve topically adjacent documents per
 *    cluster against recall@8, so retrieving the right *subject* is not enough; the
 *    ranker has to order within it. Four clusters of eight would hand every query a
 *    free hit.
 * 2. **`semantic` queries share no word with their answer.** Not one significant
 *    stem, while sharing plenty with the distractors around it. Lexical search
 *    cannot score above chance on these, so they are what makes the semantic arm
 *    prove itself (and what would have caught the DD-008 prefix bug).
 * 3. **`lexical` queries turn on a token that appears in exactly one document.** An
 *    identifier or error code, in a cluster where a dozen documents are semantically
 *    near-identical. Embeddings blur exact tokens, so these are what make hybrid
 *    beat semantic-only in Phase 7 rather than merely tie it.
 *
 * `hybrid` queries are the realistic middle: how an agent actually asks.
 *
 * Sessions cut *across* clusters on purpose, so a session-filtered query still
 * spans subjects — a session that mapped onto a cluster would make the filter and
 * the topic the same thing, and DD-046's filtered path would go unmeasured.
 */

export type Cluster = "storage" | "cache" | "api" | "deploy";
export type QueryKind = "semantic" | "lexical" | "hybrid";

export interface EvalDocument {
  readonly id: string;
  readonly cluster: Cluster;
  readonly content: string;
  readonly tags: readonly string[];
  readonly sessionId: string;
}

export interface EvalQuery {
  readonly id: string;
  readonly cluster: Cluster;
  readonly kind: QueryKind;
  readonly text: string;
  /** Document ids that answer it. Ordering is not implied. */
  readonly relevant: readonly string[];
  /**
   * `lexical` only: the rare token the query turns on. Must appear in the relevant
   * documents and nowhere else in the corpus.
   */
  readonly anchor?: string;
}

/** Recall@8 is the DD-021 gate; every phase comparison uses this k. */
export const EVAL_K = 8;

const SESSIONS = ["s-alpha", "s-beta", "s-gamma"] as const;

/** Spreads sessions across clusters so no session is a cluster in disguise. */
function sessionFor(index: number): string {
  const session = SESSIONS[index % SESSIONS.length];
  if (session === undefined) {
    throw new Error("SESSIONS must not be empty");
  }
  return session;
}

const RAW_DOCUMENTS: readonly (readonly [Cluster, string, string, readonly string[]])[] = [
  /* --- storage: Postgres and the memory store itself ----------------------- */
  [
    "storage",
    "a01",
    "Connection pool exhaustion caused the overnight batch to stall: the pool allowed ten clients while the scheduler starts twenty parallel tasks. Raised the ceiling to fifty and added a saturation alert.",
    ["postgres", "pool", "saturation"],
  ],
  [
    "storage",
    "a02",
    "Schema changes are forward-only. Every file applies inside pg_advisory_xact_lock so two booting instances serialize instead of racing DDL, and a partly applied file rolls back whole.",
    ["postgres", "migrations", "locking"],
  ],
  [
    "storage",
    "a03",
    "The unique index on content_hash is partial: it covers live rows only, so identical text can be stored again once the earlier copy is forgotten, while a duplicate of a live row still conflicts.",
    ["postgres", "index", "duplicates"],
  ],
  [
    "storage",
    "a04",
    "Autovacuum never kept up on the events table. Obsolete tuple versions accumulated past forty percent and index-only access stopped happening, so the scale factor was lowered for that table alone.",
    ["postgres", "autovacuum", "bloat"],
  ],
  [
    "storage",
    "a05",
    "Statement timeout is thirty seconds for application queries and disabled for migrations, because building an index is legitimately slow and failing it would leave the server unable to boot.",
    ["postgres", "timeout", "migrations"],
  ],
  [
    "storage",
    "a06",
    "Read replicas trail the primary by as much as four seconds during write bursts, so anything a person has just submitted is read from the primary instead.",
    ["postgres", "replication", "consistency"],
  ],
  [
    "storage",
    "a07",
    "The audit table is partitioned by month. Any query that omits the timestamp predicate touches every partition, which is why the quarterly reporting run degraded steadily.",
    ["postgres", "partitioning", "reporting"],
  ],
  [
    "storage",
    "a08",
    "Payloads are stored as jsonb rather than text so individual keys can be indexed, at the price of losing key order and silently collapsing repeated keys on write.",
    ["postgres", "jsonb", "schema"],
  ],
  [
    "storage",
    "a09",
    "A nightly dump lands in object storage with seven-day retention, and the restore path was rehearsed once against a scratch instance rather than assumed to work.",
    ["postgres", "backup", "restore"],
  ],
  [
    "storage",
    "a10",
    "The self-referencing foreign key is ON DELETE RESTRICT, never CASCADE, so merging a group of rows cannot quietly take its own inputs with it.",
    ["postgres", "constraints", "compaction"],
  ],
  [
    "storage",
    "a11",
    "A major version move needs pg_upgrade followed by rebuilding the extensions, because an extension's version does not track the server's and stays at whatever was installed first.",
    ["postgres", "upgrade", "extensions"],
  ],
  [
    "storage",
    "a12",
    "HNSW won over IVFFlat here: recall is better at this corpus size and there is no training step to run, paid for with a slower build and a larger memory footprint.",
    ["pgvector", "hnsw", "index"],
  ],

  /* --- cache: Redis and the recall cache ----------------------------------- */
  [
    "cache",
    "b01",
    "Cache entries embed a corpus version counter, so a deletion increments the counter and strands every previously written entry rather than needing targeted eviction.",
    ["redis", "invalidation", "versioning"],
  ],
  [
    "cache",
    "b02",
    "Eviction is set to noeviction with an explicit memory ceiling. Under allkeys-lru the untimed version counter could be discarded while the entries it scopes survive, which would resurrect a stale generation.",
    ["redis", "eviction", "maxmemory"],
  ],
  [
    "cache",
    "b03",
    "Entries live for three hundred seconds. Correctness never rests on that number — version-scoped keys make an old generation unreachable — so the lifetime only bounds wasted memory.",
    ["redis", "ttl", "memory"],
  ],
  [
    "cache",
    "b04",
    "Persistence is deliberately off. The counter and the entries it scopes have to share a lifetime, or a restart could bring back a generation that outlived its own version.",
    ["redis", "persistence", "restart"],
  ],
  [
    "cache",
    "b05",
    "A thundering herd on first request is handled by letting the first caller compute while the rest wait on the same promise, rather than by locking in Redis.",
    ["redis", "stampede", "concurrency"],
  ],
  [
    "cache",
    "b06",
    "Round trips dominate on a busy box, so the reads for one request are pipelined into a single command batch instead of awaited one at a time.",
    ["redis", "pipelining", "latency"],
  ],
  [
    "cache",
    "b07",
    "Clustering is explicitly out of scope: this is one host serving one person, and a slot-aware client would add failure modes with nothing to show for them.",
    ["redis", "cluster", "scope"],
  ],
  [
    "cache",
    "b08",
    "A degraded read is never written to the cache. An answer computed while one retrieval path was down is the outage's answer, and caching it would outlive the outage.",
    ["redis", "degradation", "correctness"],
  ],
  [
    "cache",
    "b09",
    "Keyspace notifications were rejected as an invalidation channel: they are fire-and-forget, so a missed event is indistinguishable from no event.",
    ["redis", "notifications", "invalidation"],
  ],
  [
    "cache",
    "b10",
    "No Lua scripts. The one atomic operation needed is an increment, which Redis already gives, and a script would put logic somewhere no test can reach it.",
    ["redis", "lua", "simplicity"],
  ],
  [
    "cache",
    "b11",
    "The hot list was cut from the design. Ranking by usage duplicated what the recall counter already records and gave two sources of truth for the same fact.",
    ["redis", "hotlist", "cut"],
  ],
  [
    "cache",
    "b12",
    "Cached payloads are JSON with the schema version in the key, so a shape change cannot be read back through the wrong parser.",
    ["redis", "serialization", "schema"],
  ],

  /* --- api: contracts, auth, and the surfaces ------------------------------ */
  [
    "api",
    "c01",
    "Short-lived bearer tokens issued by the gateway and rotated hourly. Cookies were rejected because the calling agent has nowhere to keep them.",
    ["auth", "tokens", "gateway"],
  ],
  [
    "api",
    "c02",
    "The token comparison is constant-time. A byte-by-byte equality check leaks the prefix through timing, which is a real attack over a quiet LAN.",
    ["auth", "timing", "security"],
  ],
  [
    "api",
    "c03",
    "Cross-origin requests are refused outright rather than allowed with a wildcard, because nothing in a browser is meant to reach this service.",
    ["http", "cors", "security"],
  ],
  [
    "api",
    "c04",
    "Writes carry an idempotency key so a client that retries after a timeout gets the original outcome instead of a second copy of the same work.",
    ["http", "idempotency", "retries"],
  ],
  [
    "api",
    "c05",
    "Both surfaces validate against one shared schema, so a field renamed for one of them cannot drift out of step with the other.",
    ["contracts", "validation", "surfaces"],
  ],
  [
    "api",
    "c06",
    "Only authored text crosses the boundary. A driver message can embed statements, parameter values and credentials, so the wrapped cause stays in the log.",
    ["errors", "security", "logging"],
  ],
  [
    "api",
    "c07",
    "An empty result is a successful response with an empty list, never an error. Conflating the two teaches the caller to retry a question that was answered.",
    ["errors", "contracts", "semantics"],
  ],
  [
    "api",
    "c08",
    "Every error carries a machine-readable code alongside its message, because a caller that has to match on prose breaks the first time the wording improves.",
    ["errors", "contracts", "codes"],
  ],
  [
    "api",
    "c09",
    "Webhook deliveries are signed with a shared secret and a timestamp, and a signature older than five minutes is rejected to stop replay.",
    ["webhooks", "signing", "replay"],
  ],
  [
    "api",
    "c10",
    "Results are capped at fifty per request. Without a ceiling a single call can pull the whole corpus into a model's context and blow the budget.",
    ["contracts", "limits", "pagination"],
  ],
  [
    "api",
    "c11",
    "Tool descriptions are part of the product: they decide whether an agent reaches for the tool at all, so they are written and reviewed rather than generated.",
    ["mcp", "tools", "documentation"],
  ],
  [
    "api",
    "c12",
    "Stored text is treated as data, never as instructions. It is fenced inside delimiters that are stripped from the input first, so a note cannot redirect the model that reads it.",
    ["prompts", "injection", "security"],
  ],

  /* --- deploy: containers, config, and operations -------------------------- */
  [
    "deploy",
    "d01",
    "The runtime image carries no build toolchain. A three-stage build compiles, prunes to production dependencies, and copies only what running needs.",
    ["docker", "image", "build"],
  ],
  [
    "deploy",
    "d02",
    "Model weights are pulled during provisioning, never as a boot dependency, because a container start that contacts a registry cannot work offline.",
    ["ollama", "provisioning", "offline"],
  ],
  [
    "deploy",
    "d03",
    "A service without a healthcheck counts as ready the moment it is running, so compose reports success while a two gigabyte download is still in flight.",
    ["compose", "healthcheck", "startup"],
  ],
  [
    "deploy",
    "d04",
    "Diagnostics go to file descriptor two. The other channel carries protocol frames, and one stray line there corrupts the stream and looks like a client bug.",
    ["logging", "stdio", "protocol"],
  ],
  [
    "deploy",
    "d05",
    "The database password has no default. An absent value fails the stack outright rather than quietly starting something reachable with the development password.",
    ["secrets", "config", "compose"],
  ],
  [
    "deploy",
    "d06",
    "Continuous integration runs typecheck, lint and tests as one command, and the container-backed suites bring their own stack up and tear it down from a trap.",
    ["ci", "testing", "containers"],
  ],
  [
    "deploy",
    "d07",
    "Rolling back means redeploying the previous image tag. Schema changes are forward-only, so a rollback that crossed one would meet a shape it does not understand.",
    ["rollback", "release", "migrations"],
  ],
  [
    "deploy",
    "d08",
    "Inference is processor-only on this hardware. There is no accelerator, so generation is treated as expensive and every bound is set generously.",
    ["hardware", "latency", "inference"],
  ],
  [
    "deploy",
    "d09",
    "Both models stay resident with a long keep-alive and a loaded-model limit of two, so the cold load is paid once per deployment instead of on alternating calls.",
    ["ollama", "keepalive", "latency"],
  ],
  [
    "deploy",
    "d10",
    "The store is not published on the network. It is reachable only across the internal compose network, because exposing it would put the whole corpus behind one password.",
    ["network", "exposure", "security"],
  ],
  [
    "deploy",
    "d11",
    "Volumes are absent from the development stack on purpose, so tearing it down returns a genuinely empty database and no test can quietly depend on yesterday's rows.",
    ["compose", "volumes", "testing"],
  ],
  [
    "deploy",
    "d12",
    "The scheduled background job holds an advisory lock, because one process per client session means several would otherwise work the same queue at once.",
    ["jobs", "locking", "concurrency"],
  ],
];

export const DOCUMENTS: readonly EvalDocument[] = RAW_DOCUMENTS.map(
  ([cluster, id, content, tags], index) => ({
    id: `${cluster}-${id}`,
    cluster,
    content,
    tags,
    sessionId: sessionFor(index),
  }),
);

export const QUERIES: readonly EvalQuery[] = [
  /* --- storage ------------------------------------------------------------- */
  {
    id: "q-storage-sem-1",
    cluster: "storage",
    kind: "semantic",
    text: "why did the nightly job hang when lots of things ran at the same time?",
    relevant: ["storage-a01"],
  },
  {
    id: "q-storage-sem-2",
    cluster: "storage",
    kind: "semantic",
    text: "reads got gradually slower because superseded copies of rows piled up",
    relevant: ["storage-a04"],
  },
  {
    id: "q-storage-lex-1",
    cluster: "storage",
    kind: "lexical",
    text: "what does pg_advisory_xact_lock protect?",
    relevant: ["storage-a02"],
    anchor: "pg_advisory_xact_lock",
  },
  {
    id: "q-storage-lex-2",
    cluster: "storage",
    kind: "lexical",
    text: "anything to remember about pg_upgrade?",
    relevant: ["storage-a11"],
    anchor: "pg_upgrade",
  },
  {
    id: "q-storage-hyb-1",
    cluster: "storage",
    kind: "hybrid",
    text: "why HNSW rather than IVFFlat for the vector index?",
    relevant: ["storage-a12"],
  },
  {
    id: "q-storage-hyb-2",
    cluster: "storage",
    kind: "hybrid",
    text: "can the same text be stored twice if the first copy was forgotten?",
    relevant: ["storage-a03"],
  },

  /* --- cache --------------------------------------------------------------- */
  {
    id: "q-cache-sem-1",
    cluster: "cache",
    kind: "semantic",
    text: "how do stale answers disappear once a memory is thrown away?",
    relevant: ["cache-b01"],
  },
  {
    id: "q-cache-sem-2",
    cluster: "cache",
    kind: "semantic",
    text: "if part of the search was broken, is the reply still saved for next time?",
    relevant: ["cache-b08"],
  },
  {
    id: "q-cache-lex-1",
    cluster: "cache",
    kind: "lexical",
    text: "why not allkeys-lru?",
    relevant: ["cache-b02"],
    anchor: "allkeys-lru",
  },
  {
    id: "q-cache-lex-2",
    cluster: "cache",
    kind: "lexical",
    text: "did we decide anything about keyspace notifications?",
    relevant: ["cache-b09"],
    anchor: "notifications",
  },
  {
    id: "q-cache-hyb-1",
    cluster: "cache",
    kind: "hybrid",
    text: "how long do cache entries live and does correctness depend on it?",
    relevant: ["cache-b03"],
  },
  {
    id: "q-cache-hyb-2",
    cluster: "cache",
    kind: "hybrid",
    text: "why is Redis persistence turned off?",
    relevant: ["cache-b04"],
  },

  /* --- api ---------------------------------------------------------------- */
  {
    id: "q-api-sem-1",
    cluster: "api",
    kind: "semantic",
    text: "does asking for the identical change more than once cause it to apply repeatedly?",
    relevant: ["api-c04"],
  },
  {
    id: "q-api-sem-2",
    cluster: "api",
    kind: "semantic",
    text: "can something saved in memory hijack the assistant later on?",
    relevant: ["api-c12"],
  },
  {
    id: "q-api-lex-1",
    cluster: "api",
    kind: "lexical",
    text: "is the comparison constant-time?",
    relevant: ["api-c02"],
    anchor: "constant-time",
  },
  {
    id: "q-api-lex-2",
    cluster: "api",
    kind: "lexical",
    text: "what did we do about idempotency keys?",
    relevant: ["api-c04"],
    anchor: "idempotency",
  },
  {
    id: "q-api-hyb-1",
    cluster: "api",
    kind: "hybrid",
    text: "does an empty search result count as an error?",
    relevant: ["api-c07"],
  },
  {
    id: "q-api-hyb-2",
    cluster: "api",
    kind: "hybrid",
    text: "what is the cap on how many results one request can return?",
    relevant: ["api-c10"],
  },

  /* --- deploy ------------------------------------------------------------- */
  {
    id: "q-deploy-sem-1",
    cluster: "deploy",
    kind: "semantic",
    text: "why fetch the large data files ahead of time instead of at launch?",
    relevant: ["deploy-d02"],
  },
  {
    id: "q-deploy-sem-2",
    cluster: "deploy",
    kind: "semantic",
    text: "where do log messages have to be written so the wire format is not damaged?",
    relevant: ["deploy-d04"],
  },
  {
    id: "q-deploy-lex-1",
    cluster: "deploy",
    kind: "lexical",
    text: "what did we find out about healthcheck behaviour?",
    relevant: ["deploy-d03"],
    anchor: "healthcheck",
  },
  {
    id: "q-deploy-lex-2",
    cluster: "deploy",
    kind: "lexical",
    text: "how is keep-alive configured?",
    relevant: ["deploy-d09"],
    anchor: "keep-alive",
  },
  {
    id: "q-deploy-hyb-1",
    cluster: "deploy",
    kind: "hybrid",
    text: "how do we roll back a bad release?",
    relevant: ["deploy-d07"],
  },
  {
    id: "q-deploy-hyb-2",
    cluster: "deploy",
    kind: "hybrid",
    text: "why does the background repair job take a lock?",
    relevant: ["deploy-d12"],
  },
];

/* --- corpus hygiene, exported so a test can enforce it ---------------------- */

/**
 * Words too common to count as overlap. Short list on purpose: a generous list
 * would let a real shared term slide through as "common" and weaken invariant 2.
 */
const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "anything",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "by",
  "can",
  "count",
  "did",
  "do",
  "does",
  "during",
  "else",
  "every",
  "for",
  "from",
  "get",
  "go",
  "goes",
  "got",
  "happen",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "kept",
  "keep",
  "lots",
  "many",
  "much",
  "must",
  "no",
  "not",
  "of",
  "on",
  "one",
  "only",
  "or",
  "other",
  "our",
  "out",
  "rather",
  "remember",
  "same",
  "should",
  "so",
  "something",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "thing",
  "things",
  "this",
  "time",
  "to",
  "twice",
  "two",
  "up",
  "us",
  "was",
  "we",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "why",
  "will",
  "with",
  "without",
  "would",
]);

/**
 * Crude suffix stripping, and crude in the strict direction: `websearch_to_tsquery`
 * stems, so an overlap check that did not would call "timeouts" and "timeout"
 * different words and let a lexically-solvable query pose as a semantic one.
 */
export function crudeStem(word: string): string {
  for (const suffix of ["ing", "edly", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Stemmed, stopworded content words. Hyphenated and underscored tokens stay whole. */
export function significantTokens(text: string): ReadonlySet<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/u)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token))
    .map(crudeStem);
  return new Set(tokens);
}
