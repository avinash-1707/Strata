import { ENHANCEMENT_TIMEOUT_MS } from "../config/budgets.js";
import type { ToolDeps } from "../deps.js";
import { describeUnknown, isStrataError } from "../errors.js";
import { assertEmbeddingDimensions } from "../ollama/embedding.js";
import { compressionJsonSchema, parseCompressionResult } from "../ollama/parse.js";
import { buildCompressionPrompt } from "../ollama/prompts.js";
import type { MemoryRecord } from "../store/types.js";
import { normalizeTags } from "../tags.js";
import { bumpCorpusVersion } from "./corpus.js";

/**
 * DD-005 stage 2, shared by `remember` and the repair job. The row is already
 * durable when this runs, so **nothing here may throw for a model failure**.
 */

export type EnhancementOutcome =
  | "enhanced"
  /** The content defeated the model; an attempt was recorded (DD-045). */
  | "degraded"
  /**
   * Infrastructure was down or too slow. **No attempt recorded**, because a
   * transport failure says nothing about this row's content, and a caller looping
   * over rows should stop rather than spend the next row's attempt on the same
   * outage (DD-045).
   */
  | "deferred"
  /** Nothing to attempt, or the row is gone. No attempt recorded. */
  | "skipped";

export interface EnhancementResult {
  /** Unchanged from the input on anything but `enhanced`. */
  readonly record: MemoryRecord;
  readonly outcome: EnhancementOutcome;
}

/** DD-006: determinism matters more than creativity here. */
const COMPRESSION_TEMPERATURE = 0;

/**
 * Why the model produced nothing usable. `content` means this row would fail
 * again on a healthy Ollama; `transport` means no row would succeed right now.
 * Only the first is evidence against the row, so only the first costs an attempt
 * (DD-045).
 */
type FailureKind = "content" | "transport";

type Attempted<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: FailureKind };

function classify(error: unknown): FailureKind {
  if (!isStrataError(error)) {
    // A non-StrataError here is a parse or validation throw from our own code, which
    // is about the answer the model gave. Unreachable service always arrives coded.
    return "content";
  }
  if (error.code === "OLLAMA_UNAVAILABLE" || error.code === "DB_QUERY_FAILED") {
    return "transport";
  }
  /* OLLAMA_BAD_RESPONSE covers two different things, and only one is the row's fault.
     An HTTP status means the model never produced output at all — and the commonest
     status here is 404 for a model that has not been pulled, which DD-047 makes a
     routine provisioning state. Charging the corpus for that writes off every row in
     five passes. Without a status, the model did answer and the answer was unusable:
     that is content. */
  return error.details?.["status"] === undefined ? "content" : "transport";
}

export async function enhanceMemory(
  record: MemoryRecord,
  deps: ToolDeps,
  budgetMs: number = ENHANCEMENT_TIMEOUT_MS,
  /* Cancels the model calls on shutdown. An aborted call surfaces as
     OLLAMA_UNAVAILABLE, which already classifies as transport — so the row is stamped
     and uncharged, which is exactly right: a call the process cancelled says nothing
     about the content (DD-045). */
  signal?: AbortSignal,
): Promise<EnhancementResult> {
  // One deadline for the whole stage: two calls each given the full budget would
  // hold the caller for twice the bound this exists to impose.
  const deadline = Date.now() + budgetMs;

  const needsCompression = record.status === "raw";
  if (!needsCompression && !record.needsEmbedding) {
    return { record, outcome: "skipped" };
  }

  let summary = record.summary;
  let tags: readonly string[] = record.tags;

  if (needsCompression) {
    const content = record.rawContent;
    if (content === null) {
      deps.log.warn({ id: record.id }, "cannot compress: raw content absent");
      /* Charged as content even though retrying cannot help, because the backlog query
         matches on `status='raw'` and this row will match forever. Without the counter
         it holds a slot in every pass — the starvation DD-041 closes, reached by a
         different arm. */
      return await charge(record, "content", deps);
    }

    const compressed = await compress(content, deps, remaining(deadline), signal);
    if (!compressed.ok) {
      return await charge(record, compressed.kind, deps);
    }

    summary = compressed.value.summary;
    tags = normalizeTags(record.tags, compressed.value.suggested_tags);
  }

  const embedded = await embed(summary, deps, remaining(deadline), signal);

  // applyEnhancement sets status='compressed', so calling it with only a new
  // embedding would mark an uncompressed row compressed.
  if (!needsCompression && !embedded.ok) {
    return await charge(record, embedded.kind, deps);
  }

  let updated: MemoryRecord | undefined;
  try {
    updated = await deps.store.applyEnhancement(record.id, {
      summary,
      tags,
      embedding: embedded.ok ? embedded.value.vector : null,
      embeddingModel: embedded.ok ? embedded.value.model : null,
    });
  } catch (error: unknown) {
    /* The row is already durable, so a database blip here must degrade like any other
       stage-2 failure rather than fail the caller's `remember` (DD-005). Uncounted:
       the write failing says nothing about the content (DD-045). */
    deps.log.warn(
      { id: record.id, error: describeUnknown(error) },
      "could not persist the enhancement",
    );
    return await charge(record, "transport", deps);
  }

  if (updated === undefined) {
    // A forget landed mid-enhancement. Recording an attempt against a dead row
    // would be noise.
    deps.log.warn({ id: record.id }, "enhancement discarded: row no longer live");
    return { record, outcome: "skipped" };
  }

  /* DD-010: this is a mutation, so it bumps. Enhancement replaces the summary an
     answer is synthesized from and adds the vector semantic search needs, so a recall
     cached before it ran is stale in both its text and its result set. `remember`
     bumping for the raw insert does not cover this: the two are separated by seconds
     of model calls, and the repair pass has no insert in front of it at all. */
  await bumpCorpusVersion(deps, "enhance");

  // Compression landed but the vector did not. The row is better than it was and
  // still incomplete, so the same rule applies to what is left of it.
  if (!embedded.ok) {
    return await charge(updated, embedded.kind, deps);
  }

  return { record: updated, outcome: "enhanced" };
}

/**
 * Turns a failure into an outcome, charging an attempt only when the content is
 * what failed (DD-045). Never throws: the row is already durable (DD-005).
 */
async function charge(
  record: MemoryRecord,
  kind: FailureKind,
  deps: ToolDeps,
): Promise<EnhancementResult> {
  if (kind === "transport") {
    // Stamped but not counted. Without the stamp the backlog hands this row to the
    // next pass too, and a row whose model call times out would abort every pass
    // from here to forever (DD-045).
    await bookkeep(deps, record.id, "defer", () => deps.store.deferEnhancement(record.id));
    return { record, outcome: "deferred" };
  }
  await bookkeep(deps, record.id, "attempt", () => deps.store.recordEnhancementAttempt(record.id));
  return { record, outcome: "degraded" };
}

/** Never throws — compression is never fatal to the write (DD-005). */
async function compress(
  content: string,
  deps: ToolDeps,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempted<{ summary: string; suggested_tags: string[] }>> {
  if (timeoutMs <= 0) {
    // Transport, not content: the budget ran out before this row was ever shown to
    // the model, so nothing was learned about it (DD-045).
    deps.log.warn({ stage: "compress" }, "enhancement budget exhausted, leaving row raw");
    return { ok: false, kind: "transport" };
  }

  try {
    const raw = await deps.ollama.generate(buildCompressionPrompt(content), {
      format: compressionJsonSchema(),
      temperature: COMPRESSION_TEMPERATURE,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    return { ok: true, value: parseCompressionResult(raw) };
  } catch (error: unknown) {
    const kind = classify(error);
    deps.log.warn(
      { stage: "compress", kind, error: describeUnknown(error) },
      "compression failed, leaving row raw",
    );
    return { ok: false, kind };
  }
}

async function embed(
  summary: string,
  deps: ToolDeps,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempted<{ vector: readonly number[]; model: string }>> {
  if (timeoutMs <= 0) {
    deps.log.warn({ stage: "embed" }, "enhancement budget exhausted, leaving row unembedded");
    return { ok: false, kind: "transport" };
  }

  try {
    const result = await deps.ollama.embed(summary, "document", {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    // Re-checked at the last point before persistence: pgvector's own rejection
    // would arrive as an opaque insert failure rather than a named degradation.
    assertEmbeddingDimensions(result.vector, result.model);
    return { ok: true, value: { vector: result.vector, model: result.model } };
  } catch (error: unknown) {
    const kind = classify(error);
    deps.log.warn(
      { stage: "embed", kind, error: describeUnknown(error) },
      "embedding failed, row keeps needs_embedding",
    );
    return { ok: false, kind };
  }
}

/** Behind an already-durable write, so a failure costs one extra retry, nothing more. */
async function bookkeep(
  deps: ToolDeps,
  id: string,
  kind: "attempt" | "defer",
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (error: unknown) {
    deps.log.warn(
      { id, kind, error: describeUnknown(error) },
      "could not record enhancement attempt",
    );
  }
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}
