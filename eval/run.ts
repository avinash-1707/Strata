/**
 * `pnpm eval` — the retrieval yardstick DD-021 requires. Reports recall@8 for four
 * arms over the seeded corpus and checks the phase gates that compare them.
 *
 *   OLLAMA_URL=http://ubuntu.local:11434 \
 *   POSTGRES_URL=postgres://strata:...@ubuntu.local:5432/strata \
 *   pnpm eval > docs/eval-baseline.md
 *
 * Unlike `scripts/truth-find.ts`, this **does** import `src/`: it measures the real
 * retrieval path, so reusing it is the point rather than the hazard. The one
 * exception is the exact-search arm, which carries its own SQL — it is the ground
 * truth the index is checked against, and ground truth computed by the code under
 * test is not ground truth.
 *
 * It never touches the live corpus. Every run drops and rebuilds a separate
 * `strata_eval` database, and refuses to start if that name resolves to the
 * configured one. The database is left behind so a bad number can be investigated.
 *
 * Report to stdout, progress to stderr, non-zero exit if a gate fails or a stage
 * could not run — a gate that reports an unwelcome number is a success; one that
 * could not measure is not.
 */

import { SEARCH_CANDIDATE_LIMIT } from "../src/config/budgets.js";
import type { Config } from "../src/config/env.js";
import { loadConfig } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import type { Db, Row } from "../src/db/types.js";
import { contentHash } from "../src/hash.js";
import { createLogger } from "../src/logger.js";
import { createOllamaClient } from "../src/ollama/client.js";
import { RRF_K, fuseRankings } from "../src/search/fusion.js";
import { createPgStore } from "../src/store/pg/index.js";
import type { MemoryStore } from "../src/store/types.js";
import type { QueryKind } from "./corpus.js";
import { DOCUMENTS, EVAL_K, QUERIES } from "./corpus.js";
import type { ArmSummary, Judgement } from "./metrics.js";
import { rankByScore, summarize } from "./metrics.js";

/** Never the configured database. The suffix is checked, not assumed. */
const EVAL_DATABASE = "strata_eval";

/** What each arm retrieves before scoring, matching what `recall` asks for. */
const CANDIDATES = Math.max(SEARCH_CANDIDATE_LIMIT, EVAL_K);

const out: string[] = [];
let failures = 0;

function say(line = ""): void {
  out.push(line);
}

function progress(line: string): void {
  console.error(`[eval] ${line}`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number, places = 3): string {
  return value.toFixed(places);
}

/* --- database plumbing ------------------------------------------------------- */

interface Target {
  readonly adminUrl: string;
  readonly evalUrl: string;
  readonly config: Config;
}

function resolveTarget(env: NodeJS.ProcessEnv): Target {
  const adminUrl = env["POSTGRES_URL"];
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error("POSTGRES_URL is required: eval needs a real Postgres with pgvector");
  }
  if (env["OLLAMA_URL"] === undefined || env["OLLAMA_URL"] === "") {
    throw new Error(
      "OLLAMA_URL is required: recall@8 over stub vectors would measure nothing (DD-021)",
    );
  }

  const parsed = new URL(adminUrl);
  const configured = parsed.pathname.replace(/^\//u, "");
  if (configured === EVAL_DATABASE) {
    throw new Error(
      `POSTGRES_URL already points at ${EVAL_DATABASE}; point it at the real database ` +
        "and let eval derive its own, or a mistake here drops the corpus",
    );
  }
  parsed.pathname = `/${EVAL_DATABASE}`;
  const evalUrl = parsed.toString();

  return {
    adminUrl,
    evalUrl,
    config: loadConfig({
      ...env,
      POSTGRES_URL: evalUrl,
      // Eval deliberately bypasses the cache: a cached recall would measure Redis.
      REDIS_URL: env["REDIS_URL"] ?? "redis://127.0.0.1:1",
    }),
  };
}

/** Drops and rebuilds the eval database so a run never inherits an earlier corpus. */
async function rebuildDatabase(target: Target): Promise<void> {
  // Derived from the validated config rather than re-read from the environment: a
  // second loadConfig would have to re-apply the same placeholders and drifted
  // immediately when one of them changed.
  const adminConfig: Config = { ...target.config, POSTGRES_URL: target.adminUrl };
  const admin = createDb(adminConfig, quietLog());
  try {
    // A module constant, never input — and `with (force)` so a connection left by a
    // crashed run cannot wedge every future one.
    await admin.query(`drop database if exists ${EVAL_DATABASE} with (force)`);
    await admin.query(`create database ${EVAL_DATABASE}`);
  } finally {
    await admin.close();
  }
}

function quietLog(): ReturnType<typeof createLogger> {
  // Warnings and errors only: an info-level line per query would bury the report's
  // own progress output on stderr.
  return createLogger("warn");
}

/* --- seeding ---------------------------------------------------------------- */

/**
 * Stores each document verbatim, with a real embedding of its own text. No
 * compression: this measures retrieval, and letting the instruct model rewrite the
 * corpus first would fold Phase 8's question into Phase 6's number.
 */
async function seed(store: MemoryStore, ollama: ReturnType<typeof createOllamaClient>): Promise<void> {
  let done = 0;
  for (const document of DOCUMENTS) {
    const embedded = await ollama.embed(document.content, "document");
    const inserted = await store.insertRaw({
      summary: document.content,
      rawContent: document.content,
      contentHash: contentHash(document.content),
      tags: document.tags,
      sessionId: document.sessionId,
    });
    const updated = await store.applyEnhancement(inserted.id, {
      summary: document.content,
      tags: document.tags,
      embedding: embedded.vector,
      embeddingModel: embedded.model,
    });
    if (updated === undefined) {
      throw new Error(`seeding lost ${document.id}: the row was not live after insert`);
    }
    // The corpus is keyed by its own ids; the database assigns uuids.
    idByDocument.set(document.id, updated.id);
    documentByRow.set(updated.id, document.id);
    done += 1;
    if (done % 12 === 0) {
      progress(`embedded and stored ${String(done)}/${String(DOCUMENTS.length)} documents`);
    }
  }
}

const idByDocument = new Map<string, string>();
const documentByRow = new Map<string, string>();

/** Corpus ids for a ranked list of database ids, dropping anything unrecognized. */
function toDocumentIds(rowIds: readonly string[]): readonly string[] {
  const mapped: string[] = [];
  for (const rowId of rowIds) {
    const documentId = documentByRow.get(rowId);
    if (documentId !== undefined) {
      mapped.push(documentId);
    }
  }
  return mapped;
}

/* --- the exact arm ----------------------------------------------------------
   Its own SQL, on purpose: this is the ground truth `searchSemantic` is measured
   against (DD-017), and asking the code under test to grade itself proves nothing.
   Index scans are priced out so every distance is genuinely computed. */

interface ExactRow extends Row {
  readonly id: string;
}

async function searchExact(db: Db, vector: readonly number[]): Promise<readonly string[]> {
  const literal = `[${vector.join(",")}]`;
  return db.withTransaction(async (tx) => {
    await tx.query("set local enable_indexscan = off; set local enable_bitmapscan = off");
    const rows = await tx.query<ExactRow>(
      `select id from memories
       where embedding is not null and superseded_by is null and deleted_at is null
       order by embedding <=> $1::vector
       limit $2`,
      [literal, CANDIDATES],
    );
    return rows.map((row) => row.id);
  });
}

/* --- arms ------------------------------------------------------------------- */

type ArmName = "exact" | "semantic" | "lexical" | "hybrid";

interface Run {
  readonly judgements: Readonly<Record<ArmName, Judgement[]>>;
}

async function runArms(
  db: Db,
  store: MemoryStore,
  ollama: ReturnType<typeof createOllamaClient>,
): Promise<Run> {
  const judgements: Record<ArmName, Judgement[]> = {
    exact: [],
    semantic: [],
    lexical: [],
    hybrid: [],
  };

  let done = 0;
  for (const query of QUERIES) {
    const embedded = await ollama.embed(query.text, "query");

    const exact = toDocumentIds(await searchExact(db, embedded.vector));
    const semanticHits = await store.searchSemantic(embedded.vector, { limit: CANDIDATES });
    const lexicalHits = await store.searchLexical(query.text, { limit: CANDIDATES });

    const semantic = toDocumentIds(semanticHits.map((hit) => hit.memory.id));
    const lexical = toDocumentIds(lexicalHits.map((hit) => hit.memory.id));

    // Exactly what `recall` fuses, with the same k, so the hybrid figure is the
    // product's behaviour rather than a variant of it.
    const fused = fuseRankings([
      { name: "lexical", ids: lexicalHits.map((hit) => hit.memory.id) },
      { name: "semantic", ids: semanticHits.map((hit) => hit.memory.id) },
    ]);
    const hybrid = toDocumentIds(rankByScore(fused));

    judgements.exact.push({ queryId: query.id, retrieved: exact, relevant: query.relevant });
    judgements.semantic.push({ queryId: query.id, retrieved: semantic, relevant: query.relevant });
    judgements.lexical.push({ queryId: query.id, retrieved: lexical, relevant: query.relevant });
    judgements.hybrid.push({ queryId: query.id, retrieved: hybrid, relevant: query.relevant });

    done += 1;
    if (done % 6 === 0) {
      progress(`scored ${String(done)}/${String(QUERIES.length)} queries`);
    }
  }

  return { judgements };
}

/* --- reporting -------------------------------------------------------------- */

const ARMS: readonly ArmName[] = ["exact", "semantic", "lexical", "hybrid"];
const KINDS: readonly QueryKind[] = ["semantic", "lexical", "hybrid"];

function summaries(run: Run): Readonly<Record<ArmName, ArmSummary>> {
  return {
    exact: summarize(run.judgements.exact, EVAL_K),
    semantic: summarize(run.judgements.semantic, EVAL_K),
    lexical: summarize(run.judgements.lexical, EVAL_K),
    hybrid: summarize(run.judgements.hybrid, EVAL_K),
  };
}

function ofKind(judgements: readonly Judgement[], kind: QueryKind): readonly Judgement[] {
  const wanted = new Set(QUERIES.filter((query) => query.kind === kind).map((query) => query.id));
  return judgements.filter((judgement) => wanted.has(judgement.queryId));
}

function reportOverall(scored: Readonly<Record<ArmName, ArmSummary>>): void {
  say(`## recall@${String(EVAL_K)} overall`);
  say();
  say("| arm | recall | MRR | missed |");
  say("| --- | --- | --- | --- |");
  for (const arm of ARMS) {
    const summary = scored[arm];
    say(
      `| ${arm} | **${percent(summary.recall)}** | ${fixed(summary.mrr)} | ` +
        `${String(summary.misses.length)}/${String(summary.queries)} |`,
    );
  }
  say();
}

function reportByKind(run: Run): void {
  say("## recall by query kind");
  say();
  say(
    "`semantic` queries share no word with their answer; `lexical` queries turn on a token only " +
      "their answer carries. Those two columns are where the arms are supposed to disagree — if " +
      "they do not, one arm is not contributing what it exists for.",
  );
  say();
  say(`| arm | ${KINDS.map((kind) => kind).join(" | ")} |`);
  say(`| --- | ${KINDS.map(() => "---").join(" | ")} |`);
  for (const arm of ARMS) {
    const cells = KINDS.map((kind) => percent(summarize(ofKind(run.judgements[arm], kind), EVAL_K).recall));
    say(`| ${arm} | ${cells.join(" | ")} |`);
  }
  say();
}

function reportMisses(scored: Readonly<Record<ArmName, ArmSummary>>): void {
  say("## what the best arm still misses");
  say();
  const misses = scored.hybrid.misses;
  if (misses.length === 0) {
    say("`hybrid` answered every query inside k. Consider a harder corpus before trusting that.");
    say();
    return;
  }
  say("| query | kind | text | expected |");
  say("| --- | --- | --- | --- |");
  for (const id of misses) {
    const query = QUERIES.find((candidate) => candidate.id === id);
    if (query === undefined) continue;
    say(`| ${query.id} | ${query.kind} | ${query.text} | ${query.relevant.join(", ")} |`);
  }
  say();
}

interface Gate {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * The comparisons the build plan gates phases on. Reported rather than asserted
 * quietly: a failed gate is a finding, and the number that produced it is the
 * evidence.
 */
function gates(run: Run, scored: Readonly<Record<ArmName, ArmSummary>>): readonly Gate[] {
  const semanticOnSemantic = summarize(ofKind(run.judgements.semantic, "semantic"), EVAL_K).recall;
  const lexicalOnSemantic = summarize(ofKind(run.judgements.lexical, "semantic"), EVAL_K).recall;

  return [
    {
      name: "Phase 6 — indexed search matches exact search (DD-017)",
      // Not equality: HNSW is approximate, and a tie is the expected result at this
      // corpus size. A shortfall means the index is losing rows exact search finds.
      passed: scored.semantic.recall >= scored.exact.recall,
      detail: `indexed ${percent(scored.semantic.recall)} vs exact ${percent(scored.exact.recall)}`,
    },
    {
      name: "Phase 6 — a query with no keyword overlap finds its memory",
      passed: semanticOnSemantic > lexicalOnSemantic,
      detail:
        `on no-overlap queries: semantic ${percent(semanticOnSemantic)} vs ` +
        `lexical ${percent(lexicalOnSemantic)}`,
    },
    {
      name: "Phase 7 — hybrid beats semantic alone (DD-016)",
      passed: scored.hybrid.recall > scored.semantic.recall,
      detail: `hybrid ${percent(scored.hybrid.recall)} vs semantic ${percent(scored.semantic.recall)}`,
    },
  ];
}

function reportGates(run: Run, scored: Readonly<Record<ArmName, ArmSummary>>): void {
  say("## gates");
  say();
  say("| gate | result | evidence |");
  say("| --- | --- | --- |");
  for (const gate of gates(run, scored)) {
    if (!gate.passed) failures += 1;
    say(`| ${gate.name} | ${gate.passed ? "PASS" : "**FAIL**"} | ${gate.detail} |`);
  }
  say();
}

/* --- main ------------------------------------------------------------------- */

async function main(): Promise<void> {
  const target = resolveTarget(process.env);

  say("# Retrieval baseline");
  say();
  say(`Generated by \`eval/run.ts\` on ${new Date().toISOString()}.`);
  say();
  say(
    `${String(DOCUMENTS.length)} documents, ${String(QUERIES.length)} queries, recall@${String(EVAL_K)}, ` +
      `${String(CANDIDATES)} candidates per arm, RRF k=${String(RRF_K)}.`,
  );
  say();
  say(
    `- embedding model: \`${target.config.EMBEDDING_MODEL}\`\n` +
      `- database: \`${EVAL_DATABASE}\` (rebuilt by this run; the live corpus is untouched)`,
  );
  say();

  progress(`rebuilding ${EVAL_DATABASE}`);
  await rebuildDatabase(target);

  const db = createDb(target.config, quietLog());
  try {
    await migrate(db);
    const store = createPgStore(db);
    const ollama = createOllamaClient(target.config);

    progress(`embedding ${String(DOCUMENTS.length)} documents`);
    await seed(store, ollama);

    progress(`running ${String(QUERIES.length)} queries across ${String(ARMS.length)} arms`);
    const run = await runArms(db, store, ollama);
    const scored = summaries(run);

    reportOverall(scored);
    reportByKind(run);
    reportGates(run, scored);
    reportMisses(scored);
  } finally {
    await db.close();
  }

  say("---");
  say();
  say(
    failures === 0
      ? "Every gate passed. Record these numbers before changing a retrieval setting — the " +
          "unmeasured-settings ledger in `docs/progress-tracker.md` lists which ones this run " +
          "is now able to settle."
      : `**${String(failures)} gate(s) failed.** Treat the numbers above as the finding; do not ` +
          "tune a constant until the failing comparison is understood.",
  );

  console.log(out.join("\n"));
  if (failures > 0) process.exitCode = 1;
}

await main();
