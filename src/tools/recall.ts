import type { RecallKey } from "../cache/types.js";
import { SEARCH_CANDIDATE_LIMIT } from "../config/budgets.js";
import type { RecallInput, RecallOutput, RecallResult } from "../contracts/recall.js";
import type { ToolDeps } from "../deps.js";
import { describeUnknown, wrapError } from "../errors.js";
import { assertEmbeddingDimensions } from "../ollama/embedding.js";
import { buildSynthesisPrompt } from "../ollama/prompts.js";
import { fuseRankings } from "../search/fusion.js";
import type { RankedMemory, SearchOptions } from "../store/types.js";

/**
 * Cheapest stage first, early return only on a cache hit. Postgres is load-bearing;
 * Redis and Ollama are not — so this fails only when no search path served.
 */
export async function recall(input: RecallInput, deps: ToolDeps): Promise<RecallOutput> {
  const key: RecallKey = {
    query: input.query,
    k: input.k,
    synthesize: input.synthesize,
    ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
  };

  const startedAt = performance.now();

  // Read once and reuse for the write: re-reading after the pipeline would store
  // pre-mutation results under a post-mutation key (DD-010).
  const version = await readVersion(deps);
  if (version !== undefined) {
    const cached = await readCache(deps, version, key);
    if (cached !== undefined) {
      recordUsage(deps, cached.results);
      deps.log.debug(
        { tool: "recall", cacheHit: true, totalMs: elapsed(startedAt) },
        "recall served from cache",
      );
      return cached;
    }
  }

  const cacheMs = elapsed(startedAt);
  const searchOptions: SearchOptions = {
    // Never below `k`: MAX_RECALL_K is 50 while the candidate budget is 20, so a
    // fixed 20 would cap a k=50 request at the size of the two lists' union and
    // silently return fewer results than the caller asked for.
    limit: Math.max(SEARCH_CANDIDATE_LIMIT, input.k),
    ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
  };

  const searchStartedAt = performance.now();
  const [lexical, semantic] = await Promise.allSettled([
    deps.store.searchLexical(input.query, searchOptions),
    searchSemantic(input.query, deps, searchOptions),
  ]);
  const searchMs = elapsed(searchStartedAt);

  const lexicalHits = unwrap(lexical, deps, "lexical");
  const semanticHits = semantic.status === "fulfilled" ? semantic.value.hits : [];
  if (semantic.status === "rejected") {
    warnPathFailed(deps, "semantic", semantic.reason);
  }

  // An empty list is a legitimate result; an unserved one is not. Failing here is
  // the "Postgres down" row of the failure-mode table.
  const semanticServed = semantic.status === "fulfilled" && semantic.value.storeReached;
  if (lexical.status === "rejected" && !semanticServed) {
    throw wrapError("DB_QUERY_FAILED", "no search path could be served", lexical.reason);
  }

  const fuseStartedAt = performance.now();
  const results = fuse(lexicalHits, semanticHits, input.k);
  const fuseMs = elapsed(fuseStartedAt);

  // A result computed while a retrieval path was down is not the answer this query
  // has; it is the answer the outage had. Tracked so it is never cached.
  const retrievalDegraded = lexical.status === "rejected" || !semanticServed;

  const synthesisStartedAt = performance.now();
  const answer = input.synthesize
    ? await synthesize(input.query, results, deps, retrievalDegraded)
    : undefined;
  const synthesisMs = elapsed(synthesisStartedAt);

  const output: RecallOutput = {
    results,
    ...(answer === undefined ? {} : { answer }),
  };

  recordUsage(deps, results);

  /* Caching a degraded result outlives the outage that caused it. The worst shape is
     an Ollama outage plus a keyword-poor query: zero results, an authored "nothing
     matched", cached under the live corpus version — so the same question keeps being
     told memory is empty long after the model came back. */
  const synthesisDegraded = input.synthesize && answer === undefined;
  if (version !== undefined && !retrievalDegraded && !synthesisDegraded) {
    await writeCache(deps, version, key, output);
  }

  deps.log.debug(
    {
      tool: "recall",
      cacheHit: false,
      resultCount: results.length,
      degraded: retrievalDegraded || synthesisDegraded,
      cacheMs,
      // Lexical and semantic share one figure because they run concurrently;
      // separate numbers would imply a sequence that is not there.
      searchMs,
      fuseMs,
      synthesisMs,
    },
    "recall stage timings",
  );

  return output;
}

/**
 * `storeReached` distinguishes "the corpus had nothing" from "the embed call failed
 * before any search ran". Without it, an Ollama outage plus a Postgres outage would
 * look like an empty corpus and return `results: []` instead of failing.
 */
async function searchSemantic(
  query: string,
  deps: ToolDeps,
  options: SearchOptions,
): Promise<{ hits: readonly RankedMemory[]; storeReached: boolean }> {
  let vector: readonly number[];
  try {
    const embedded = await deps.ollama.embed(query, "query", {
      timeoutMs: deps.config.OLLAMA_TIMEOUT_MS,
    });
    // Checked before the vector reaches pgvector, which errors on a width mismatch
    // rather than skipping rows. Without this a model swap surfaces as an opaque query
    // failure instead of the named degradation to lexical-only.
    assertEmbeddingDimensions(embedded.vector, embedded.model);
    vector = embedded.vector;
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "recall", stage: "embed", error: describeUnknown(error) },
      "query embedding failed, degrading to lexical-only",
    );
    return { hits: [], storeReached: false };
  }

  return { hits: await deps.store.searchSemantic(vector, options), storeReached: true };
}

function fuse(
  lexicalHits: readonly RankedMemory[],
  semanticHits: readonly RankedMemory[],
  k: number,
): RecallResult[] {
  const byId = new Map<string, RankedMemory>();
  for (const hit of lexicalHits) {
    byId.set(hit.memory.id, hit);
  }
  // Semantic second, deliberately: it carries the cosine a lexical hit has no way
  // to supply (DD-033).
  for (const hit of semanticHits) {
    byId.set(hit.memory.id, hit);
  }

  const fused = fuseRankings([
    { name: "lexical", ids: lexicalHits.map((hit) => hit.memory.id) },
    { name: "semantic", ids: semanticHits.map((hit) => hit.memory.id) },
  ]);

  const results: RecallResult[] = [];
  for (const hit of fused.slice(0, k)) {
    const ranked = byId.get(hit.id);
    if (ranked === undefined) {
      continue;
    }
    results.push(toResult(ranked, hit.score));
  }
  return results;
}

function toResult(ranked: RankedMemory, score: number): RecallResult {
  return {
    id: ranked.memory.id,
    summary: ranked.memory.summary,
    tags: [...ranked.memory.tags],
    score,
    ...(ranked.similarity === undefined ? {} : { similarity: ranked.similarity }),
  };
}

/**
 * DD-042: with nothing retrieved, the answer is authored rather than generated. A
 * CPU-bound generation (DD-028) to say "nothing found" costs seconds and risks the
 * model filling the gap from its own knowledge, which is the one thing synthesis
 * must never do.
 */
const NO_RESULTS_ANSWER =
  "No stored memories matched this query, so there is nothing to answer from.";

async function synthesize(
  query: string,
  results: readonly RecallResult[],
  deps: ToolDeps,
  retrievalDegraded: boolean,
): Promise<string | undefined> {
  if (results.length === 0) {
    /* DD-042's "an authored sentence cannot hallucinate" holds only if the search
       actually ran. Asserting the corpus had nothing, when half of retrieval was
       down, is a confident wrong answer — exactly what the honesty instruction in
       the synthesis prompt exists to prevent. */
    if (retrievalDegraded) {
      deps.log.warn({ tool: "recall" }, "no results and retrieval degraded, omitting answer");
      return undefined;
    }
    return NO_RESULTS_ANSWER;
  }

  try {
    const answer = await deps.ollama.generate(buildSynthesisPrompt(query, results), {
      timeoutMs: deps.config.OLLAMA_TIMEOUT_MS,
    });
    // A reachable but confused model does return "". Omitting `answer` is honest;
    // returning blank prose as an answer is not.
    if (answer.trim().length === 0) {
      deps.log.warn({ tool: "recall" }, "synthesis returned nothing, omitting answer");
      return undefined;
    }
    return answer;
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "recall", stage: "synthesis", error: describeUnknown(error) },
      "synthesis failed, returning fused results without an answer",
    );
    return undefined;
  }
}

/** DD-011: off the response path — awaiting it makes a hit slower than the miss it replaced. */
function recordUsage(deps: ToolDeps, results: readonly { id: string }[]): void {
  if (results.length === 0) {
    return;
  }
  const ids = results.map((result) => result.id);
  deps.background("recall:usage", () => deps.store.touchUsage(ids));
}

async function readVersion(deps: ToolDeps): Promise<number | undefined> {
  try {
    return await deps.cache.getCorpusVersion();
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "recall", error: describeUnknown(error) },
      "corpus version unavailable, running uncached",
    );
    return undefined;
  }
}

async function readCache(
  deps: ToolDeps,
  version: number,
  key: RecallKey,
): Promise<RecallOutput | undefined> {
  try {
    return await deps.cache.getRecall(version, key);
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "recall", error: describeUnknown(error) },
      "recall cache read failed, continuing uncached",
    );
    return undefined;
  }
}

async function writeCache(
  deps: ToolDeps,
  version: number,
  key: RecallKey,
  value: RecallOutput,
): Promise<void> {
  try {
    await deps.cache.setRecall(version, key, value);
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "recall", error: describeUnknown(error) },
      "recall cache write failed, result still served",
    );
  }
}

function unwrap(
  settled: PromiseSettledResult<readonly RankedMemory[]>,
  deps: ToolDeps,
  path: string,
): readonly RankedMemory[] {
  if (settled.status === "fulfilled") {
    return settled.value;
  }
  warnPathFailed(deps, path, settled.reason);
  return [];
}

function warnPathFailed(deps: ToolDeps, path: string, reason: unknown): void {
  deps.log.warn(
    { tool: "recall", path, error: describeUnknown(reason) },
    "search path failed, fusing over the survivor",
  );
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
