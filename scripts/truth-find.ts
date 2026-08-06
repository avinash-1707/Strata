/**
 * Phase 5 model truth-finding (DD-022, DD-029). Throwaway by design.
 *
 * Turns the `// UNVERIFIED (DD-029)` markers in src/ollama/ into measured facts.
 * Deliberately imports nothing from src/ and re-issues every request literally:
 * reusing the client would make it agree with itself, and the one question worth
 * asking here is whether that client is wrong. Lint enforces the ban.
 *
 *   OLLAMA_URL=http://ubuntu.local:11434 pnpm truth-find > docs/model-findings.md
 *
 * Ollama is not published by docker-compose.prod.yml, so from the Mac reach it
 * through a forward — no weights ever land here (DD-027):
 *
 *   ssh -N -L 11434:localhost:11434 ubuntu &
 *
 * Writes the report to stdout and progress to stderr, so a redirect captures the
 * report alone. Exits non-zero if any probe failed to run — a probe that reports
 * an unwelcome answer is a success; one that could not ask is not.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const INSTRUCT_MODEL = process.env.INSTRUCT_MODEL ?? "qwen2.5:3b-instruct";
/** DD-028 picks between these two on measured CPU latency. */
const FALLBACK_INSTRUCT_MODEL = process.env.FALLBACK_INSTRUCT_MODEL ?? "qwen2.5:1.5b-instruct";

/** src/ollama/embedding.ts hard-codes this, and the vector(768) column agrees. */
const EXPECTED_DIMENSIONS = 768;

/** Generous: a cold model load on CPU precedes the first call (DD-028). */
const PROBE_TIMEOUT_MS = 180_000;

const out: string[] = [];
let failures = 0;

function say(line = ""): void {
  out.push(line);
}

function progress(line: string): void {
  console.error(`[truth-find] ${line}`);
}

/* --- transport -------------------------------------------------------------- */

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly elapsedMs: number;
}

async function post(path: string, body: unknown): Promise<HttpResult> {
  const started = performance.now();
  const response = await fetch(new URL(path, OLLAMA_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw, elapsedMs };
}

async function get(path: string): Promise<HttpResult> {
  const started = performance.now();
  const response = await fetch(new URL(path, OLLAMA_URL), {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw, elapsedMs };
}

/* --- narrowing --------------------------------------------------------------
   Hand-written rather than schema-validated on purpose: a strict parse throws
   away the diagnostic, and what the server actually returned *is* the finding. */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") return undefined;
    result.push(item);
  }
  return result;
}

/** The nested `embeddings: [[...]]` shape src/ollama/client.ts assumes. */
function firstEmbedding(body: unknown): number[] | undefined {
  const record = asRecord(body);
  if (record === undefined) return undefined;
  const outer = record["embeddings"];
  if (!Array.isArray(outer) || outer.length === 0) return undefined;
  return asNumberArray(outer[0]);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function fixed(value: number, places = 4): string {
  return value.toFixed(places);
}

async function probe(title: string, work: () => Promise<void>): Promise<void> {
  progress(title);
  say(`## ${title}`);
  say();
  try {
    await work();
  } catch (error: unknown) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    say(`**PROBE FAILED — could not measure.** \`${message}\``);
    progress(`FAILED: ${message}`);
  }
  say();
}

/* --- embedding helper -------------------------------------------------------- */

async function embed(model: string, input: string, truncate?: boolean): Promise<HttpResult> {
  return post("/api/embed", {
    model,
    input,
    ...(truncate === undefined ? {} : { truncate }),
  });
}

async function embedVector(model: string, input: string): Promise<number[]> {
  const result = await embed(model, input);
  const vector = firstEmbedding(result.body);
  if (vector === undefined) {
    throw new Error(`no embedding in response (status ${String(result.status)}): ${result.raw.slice(0, 200)}`);
  }
  return vector;
}

/* --- the DD-008 corpus -------------------------------------------------------
   Question/document pairs, not paraphrase pairs. The prefixes exist to break
   biencoder symmetry, so a corpus of near-identical strings would score well
   under either configuration and measure nothing. */

const PAIRS: readonly { readonly query: string; readonly document: string }[] = [
  {
    query: "why did the job queue start timing out?",
    document:
      "Postgres connection pool exhaustion caused job timeouts: the pool allowed 10 connections while the worker spawns 20 concurrent jobs. Raised the pool maximum to 50.",
  },
  {
    query: "what auth scheme did we pick for the API?",
    document:
      "Settled on short-lived bearer tokens issued by the gateway, rotated hourly. Session cookies were rejected because the mobile client cannot hold them.",
  },
  {
    query: "how do we handle database migrations on deploy?",
    document:
      "Migrations are forward-only and run inside an advisory lock at boot, so concurrent instances serialize instead of racing DDL against each other.",
  },
  {
    query: "which vector index are we using and why?",
    document:
      "HNSW over IVFFlat: recall is materially better at our corpus size and it needs no training step, at the cost of a slower build and more memory.",
  },
  {
    query: "what broke the nightly export last week?",
    document:
      "The nightly export failed because the S3 credentials expired; the job retried silently and reported success, which is why nobody noticed for four days.",
  },
  {
    query: "how is caching invalidated when something is deleted?",
    document:
      "Cache keys embed a corpus version counter. Any delete increments it, which strands every previously cached entry rather than requiring targeted eviction.",
  },
  {
    query: "what is the retry policy for the payment webhook?",
    document:
      "Payment webhooks retry with exponential backoff for 24 hours, then land in a dead-letter queue that pages the on-call engineer.",
  },
  {
    query: "why is logging written to stderr instead of stdout?",
    document:
      "stdout carries the JSON-RPC protocol frames, so any log line written there corrupts the stream and surfaces as a client-side parse error.",
  },
  {
    query: "what did we decide about running models on the laptop?",
    document:
      "Inference is CPU-only on the target hardware; there is no GPU, so generation latency is treated as expensive and timeouts are set generously.",
  },
  {
    query: "how large can a single stored note be?",
    document:
      "Summaries are truncated at 8000 characters before storage. Raw content is indexed separately, so the limit is not a matching budget.",
  },
];

/** recall@1 over the full query x document matrix, plus the separation margin. */
function scoreMatrix(
  queryVectors: readonly number[][],
  documentVectors: readonly number[][],
): { readonly recallAt1: number; readonly matched: number; readonly mismatched: number } {
  let hits = 0;
  const matchedScores: number[] = [];
  const mismatchedScores: number[] = [];

  for (let i = 0; i < queryVectors.length; i += 1) {
    const q = queryVectors[i];
    if (q === undefined) continue;
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < documentVectors.length; j += 1) {
      const d = documentVectors[j];
      if (d === undefined) continue;
      const score = cosine(q, d);
      if (i === j) matchedScores.push(score);
      else mismatchedScores.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = j;
      }
    }
    if (bestIndex === i) hits += 1;
  }

  return {
    recallAt1: queryVectors.length === 0 ? 0 : hits / queryVectors.length,
    matched: mean(matchedScores),
    mismatched: mean(mismatchedScores),
  };
}

/* --- probes ------------------------------------------------------------------ */

async function probeServer(): Promise<void> {
  const version = await get("/api/version");
  const versionText = asString(asRecord(version.body)?.["version"]) ?? "unknown";
  say(`- Ollama version: \`${versionText}\``);
  say(`- \`OLLAMA_URL\`: \`${OLLAMA_URL}\``);

  const tags = await get("/api/tags");
  const models = asRecord(tags.body)?.["models"];
  const names: string[] = [];
  if (Array.isArray(models)) {
    for (const entry of models) {
      const name = asString(asRecord(entry)?.["model"]);
      if (name !== undefined) names.push(name);
    }
  }
  say(`- Models present: ${names.length === 0 ? "_none_" : names.map((n) => `\`${n}\``).join(", ")}`);
  say();
  say(
    `> \`/api/embed\` requires Ollama >= 0.3.4 and JSON-Schema \`format\` requires >= 0.5.0. ` +
      `If the version above is older, the probes below fail for that reason and not because ` +
      `src/ollama is wrong.`,
  );
}

/**
 * The DD-008 question, and the one that cannot be deferred: an unprefixed corpus
 * lives in a different vector space than prefixed queries, so getting this wrong
 * is not a bug fix later — it is a full re-embed.
 */
async function probeModelfile(): Promise<void> {
  const shown = await post("/api/show", { model: EMBEDDING_MODEL });
  const record = asRecord(shown.body);
  if (record === undefined) {
    throw new Error(`/api/show returned status ${String(shown.status)}: ${shown.raw.slice(0, 300)}`);
  }

  const template = asString(record["template"]) ?? "";
  const modelfile = asString(record["modelfile"]) ?? "";

  say("Template Ollama renders around the input:");
  say("```");
  say(template.trim() === "" ? "(empty)" : template.trim());
  say("```");

  const injects = /search_document|search_query/i.test(`${template}\n${modelfile}`);
  say(
    injects
      ? "**Ollama's packaged Modelfile DOES reference a task prefix.** src/ollama/client.ts " +
          "prepends one as well, so the model is being double-prefixed. Amend DD-008 and remove " +
          "the client-side prefix rather than keeping both."
      : "**Ollama's packaged Modelfile does NOT inject a task prefix.** The caller must prepend " +
          "it, which is what src/ollama/client.ts does. DD-008 is implemented as written.",
  );
  say();

  const info = asRecord(record["model_info"]);
  if (info !== undefined) {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith(".context_length") || key.endsWith(".embedding_length")) {
        say(`- \`${key}\`: ${String(asNumber(value) ?? "?")}`);
      }
    }
  }
  const parameters = asString(record["parameters"]);
  if (parameters !== undefined && parameters.includes("num_ctx")) {
    say(`- \`PARAMETER\` block declares: \`${parameters.split("\n").filter((l) => l.includes("num_ctx")).join("; ")}\``);
  }
  say();
  say("> Declared context length is the model default, not necessarily the effective one — see the truncation probe.");
}

async function probeEmbedShape(): Promise<void> {
  const result = await embed(EMBEDDING_MODEL, "connection pool exhaustion caused job timeouts");
  say(`- \`POST /api/embed\` status: **${String(result.status)}**`);

  if (result.status === 404) {
    say(
      "- **`/api/embed` is not served by this build.** Only the deprecated `/api/embeddings` " +
        "exists, which takes `prompt` (a string) and returns a flat `embedding`. " +
        "src/ollama/client.ts must either be changed or the Ollama pin raised to >= 0.3.4.",
    );
    return;
  }

  const record = asRecord(result.body);
  say(`- Top-level keys: ${Object.keys(record ?? {}).map((k) => `\`${k}\``).join(", ") || "_none_"}`);

  const vector = firstEmbedding(result.body);
  if (vector === undefined) {
    say(`- **Response is not \`{ embeddings: [[...]] }\`.** Raw: \`${result.raw.slice(0, 300)}\``);
    return;
  }
  say(`- Nested \`embeddings[0]\` present: **yes** (the assumed shape)`);
  say(
    `- Dimensions: **${String(vector.length)}** ` +
      (vector.length === EXPECTED_DIMENSIONS
        ? `— matches \`EMBEDDING_DIMENSIONS\` and \`vector(768)\``
        : `— **MISMATCH.** src/ollama/embedding.ts expects ${String(EXPECTED_DIMENSIONS)} and the ` +
          `column is \`vector(${String(EXPECTED_DIMENSIONS)})\`. Migration required.`),
  );

  /* DD-009: the client stores whatever name Ollama reports, while config holds
     EMBEDDING_MODEL. If these differ, Phase 6's re-embed backfill compares
     `embedding_model <> $EMBEDDING_MODEL` and never converges. */
  const reported = asString(record?.["model"]);
  say(`- Provenance string Ollama reports: \`${reported ?? "(absent)"}\` vs configured \`${EMBEDDING_MODEL}\``);
  if (reported !== undefined && reported !== EMBEDDING_MODEL) {
    say(
      `  - **They differ.** Pick the canonical form now and normalize on write, or the Phase 6 ` +
        `re-embed backfill loops forever (DD-009).`,
    );
  }
}

/** DD-008, measured rather than argued. */
async function probePrefixEffect(): Promise<void> {
  const queries = PAIRS.map((p) => p.query);
  const documents = PAIRS.map((p) => p.document);

  progress(`embedding ${String(PAIRS.length * 4)} texts for the prefix A/B`);

  const bare = {
    queries: [] as number[][],
    documents: [] as number[][],
  };
  const prefixed = {
    queries: [] as number[][],
    documents: [] as number[][],
  };

  for (const q of queries) {
    bare.queries.push(await embedVector(EMBEDDING_MODEL, q));
    prefixed.queries.push(await embedVector(EMBEDDING_MODEL, `search_query: ${q}`));
  }
  for (const d of documents) {
    bare.documents.push(await embedVector(EMBEDDING_MODEL, d));
    prefixed.documents.push(await embedVector(EMBEDDING_MODEL, `search_document: ${d}`));
  }

  const withoutPrefix = scoreMatrix(bare.queries, bare.documents);
  const withPrefix = scoreMatrix(prefixed.queries, prefixed.documents);

  say(`${String(PAIRS.length)} question/document pairs, scored as a full ${String(PAIRS.length)}x${String(PAIRS.length)} matrix.`);
  say();
  say("| configuration | recall@1 | mean matched cos | mean mismatched cos | margin |");
  say("| --- | --- | --- | --- | --- |");
  say(
    `| no prefix | ${fixed(withoutPrefix.recallAt1, 2)} | ${fixed(withoutPrefix.matched)} | ` +
      `${fixed(withoutPrefix.mismatched)} | ${fixed(withoutPrefix.matched - withoutPrefix.mismatched)} |`,
  );
  say(
    `| \`search_query:\` / \`search_document:\` | ${fixed(withPrefix.recallAt1, 2)} | ` +
      `${fixed(withPrefix.matched)} | ${fixed(withPrefix.mismatched)} | ` +
      `${fixed(withPrefix.matched - withPrefix.mismatched)} |`,
  );
  say();

  const marginGain =
    withPrefix.matched - withPrefix.mismatched - (withoutPrefix.matched - withoutPrefix.mismatched);
  say(`Margin change from prefixing: **${marginGain >= 0 ? "+" : ""}${fixed(marginGain)}**`);
  say();
  say(
    marginGain > 0 || withPrefix.recallAt1 > withoutPrefix.recallAt1
      ? "Prefixing separates matched from mismatched pairs better. DD-008 stands: keep the prefix."
      : "**Prefixing did not help on this corpus.** Do not silently drop DD-008 on this alone — " +
          "10 pairs is a small sample and the effect is largest on question-shaped queries. " +
          "Re-run with a larger corpus before amending.",
  );
}

/**
 * `truncate` defaults to true, so oversized input is silently shortened rather
 * than rejected — a memory whose tail never reaches the vector, with no error.
 */
async function probeTruncation(): Promise<void> {
  const long = "the connection pool was exhausted and the worker timed out. ".repeat(2_000);
  say(`Input: ${String(long.length)} characters (~${String(Math.round(long.length / 4))} tokens).`);
  say();

  const truncated = await embed(EMBEDDING_MODEL, long);
  const promptEvalCount = asNumber(asRecord(truncated.body)?.["prompt_eval_count"]);
  say(`- \`truncate: true\` (the default) → status **${String(truncated.status)}**`);
  say(`- \`prompt_eval_count\`: **${promptEvalCount === undefined ? "absent" : String(promptEvalCount)}**`);
  if (promptEvalCount !== undefined) {
    say(`  - This is the effective context ceiling in tokens, whatever \`/api/show\` declared.`);
  }

  const strict = await embed(EMBEDDING_MODEL, long, false);
  say(`- \`truncate: false\` → status **${String(strict.status)}**`);
  say(
    strict.status >= 400
      ? "  - Oversized input errors when truncation is disabled, so the ceiling is detectable."
      : "  - **Oversized input did not error even with `truncate: false`.**",
  );
  say();
  say(
    "> Strata never sets `truncate`, so it gets the default. Any memory longer than the ceiling " +
      "above is embedded from its opening fragment only, silently. Decide in Phase 6 whether to " +
      "chunk, reject, or accept this.",
  );
}

/** DD-006: structured output is what makes compression parseable. */
async function probeStructuredGeneration(): Promise<void> {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      suggested_tags: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "suggested_tags"],
  };

  const result = await post("/api/generate", {
    model: INSTRUCT_MODEL,
    prompt:
      'Compress this note into JSON with keys "summary" and "suggested_tags": ' +
      "spent the afternoon on it, the connection pool was capped at 10 but the worker " +
      "spawns 20 concurrent jobs so it kept timing out. bumped it to 50 and it is fine now.",
    stream: false,
    format: schema,
    options: { temperature: 0 },
  });

  say(`- Status: **${String(result.status)}** in ${String(Math.round(result.elapsedMs))} ms`);
  const record = asRecord(result.body);
  const response = asString(record?.["response"]);
  say(`- \`response\` field present: **${response === undefined ? "NO" : "yes"}**`);
  if (response === undefined) {
    say(`- Raw: \`${result.raw.slice(0, 300)}\``);
    return;
  }

  say(`- \`prompt_eval_count\`: ${String(asNumber(record?.["prompt_eval_count"]) ?? "absent")}, ` +
    `\`eval_count\`: ${String(asNumber(record?.["eval_count"]) ?? "absent")}`);
  say();
  say("Returned text:");
  say("```json");
  say(response.slice(0, 800));
  say("```");

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    say("**Not parseable as JSON even with a schema-valued `format`.**");
    return;
  }
  const parsedRecord = asRecord(parsed);
  const hasSummary = asString(parsedRecord?.["summary"]) !== undefined;
  const hasTags = Array.isArray(parsedRecord?.["suggested_tags"]);
  say(
    hasSummary && hasTags
      ? "Parses cleanly and both required keys are present — DD-006 holds, and " +
          "src/ollama/parse.ts's brace-scanning fallback is belt-and-braces rather than load-bearing."
      : `**Schema not honoured.** summary: ${String(hasSummary)}, suggested_tags: ${String(hasTags)}.`,
  );
}

/** DD-028: 3b vs 1.5b is decided here, on measured CPU latency. */
async function probeLatency(): Promise<void> {
  const embedSamples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await embed(EMBEDDING_MODEL, `latency sample ${String(i)} for the embedding model`);
    embedSamples.push(result.elapsedMs);
  }
  say(`- Embedding (\`${EMBEDDING_MODEL}\`), 5 calls: mean **${String(Math.round(mean(embedSamples)))} ms**`);
  say();

  say("| instruct model | status | mean latency | eval tokens | tok/s |");
  say("| --- | --- | --- | --- | --- |");

  for (const model of [INSTRUCT_MODEL, FALLBACK_INSTRUCT_MODEL]) {
    const samples: number[] = [];
    const tokens: number[] = [];
    let status = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = await post("/api/generate", {
        model,
        prompt: "Summarize in one sentence: the connection pool was too small for the worker's concurrency.",
        stream: false,
        options: { temperature: 0 },
      });
      status = result.status;
      if (result.status !== 200) break;
      samples.push(result.elapsedMs);
      const evalCount = asNumber(asRecord(result.body)?.["eval_count"]);
      if (evalCount !== undefined) tokens.push(evalCount);
    }
    if (samples.length === 0) {
      say(`| \`${model}\` | ${String(status)} | _not measured_ | — | — |`);
      continue;
    }
    const meanMs = mean(samples);
    const meanTokens = mean(tokens);
    const tokensPerSecond = meanMs === 0 ? 0 : (meanTokens / meanMs) * 1000;
    say(
      `| \`${model}\` | ${String(status)} | **${String(Math.round(meanMs))} ms** | ` +
        `${String(Math.round(meanTokens))} | ${fixed(tokensPerSecond, 1)} |`,
    );
  }

  say();
  say(
    "> First call to each model includes a cold load, which dominates on CPU. Re-run if the " +
      "first row looks anomalous. `OLLAMA_KEEP_ALIVE=24h` and `OLLAMA_MAX_LOADED_MODELS=2` in " +
      "docker-compose.prod.yml exist to keep both resident so this cost is paid once.",
  );
  say();
  say(
    "> Compare against `ENHANCEMENT_TIMEOUT_MS` (5000) and `OLLAMA_TIMEOUT_MS` (60000). If " +
      "generation exceeds the enhancement budget, every write degrades to `status:'raw'` and " +
      "the repair job carries the whole corpus (DD-005).",
  );
}

/* --- main -------------------------------------------------------------------- */

async function main(): Promise<void> {
  say("# Model findings");
  say();
  say(`Generated by \`scripts/truth-find.ts\` on ${new Date().toISOString()}.`);
  say();
  say(
    "Every number here replaces a `// UNVERIFIED (DD-029)` assumption. Re-run after any change " +
      "to the Ollama pin or either model.",
  );
  say();

  await probe("Server and models", probeServer);
  await probe("Packaged Modelfile and the DD-008 prefix question", probeModelfile);
  await probe("`/api/embed` endpoint and response shape", probeEmbedShape);
  await probe("Prefix effect on retrieval (DD-008)", probePrefixEffect);
  await probe("Effective context and silent truncation", probeTruncation);
  await probe("Schema-constrained generation (DD-006)", probeStructuredGeneration);
  await probe("CPU latency: 3b vs 1.5b (DD-028)", probeLatency);

  say("---");
  say();
  say(
    failures === 0
      ? "All probes ran. Reconcile each finding with its `// UNVERIFIED (DD-029)` marker in `src/`."
      : `**${String(failures)} probe(s) could not run.** The findings above are incomplete.`,
  );

  console.log(out.join("\n"));
  if (failures > 0) process.exitCode = 1;
}

await main();
