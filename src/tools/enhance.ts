import { ENHANCEMENT_TIMEOUT_MS } from "../config/budgets.js";
import type { ToolDeps } from "../deps.js";
import { describeUnknown } from "../errors.js";
import { assertEmbeddingDimensions } from "../ollama/embedding.js";
import { compressionJsonSchema, parseCompressionResult } from "../ollama/parse.js";
import { buildCompressionPrompt } from "../ollama/prompts.js";
import type { MemoryRecord } from "../store/types.js";
import { normalizeTags } from "../tags.js";

/**
 * DD-005 stage 2, shared by `remember` and the repair job. The row is already
 * durable when this runs, so **nothing here may throw for a model failure**.
 */

export type EnhancementOutcome =
  | "enhanced"
  /** Row still needs work; an attempt was recorded. */
  | "degraded"
  /** Nothing to attempt, or the row is gone. No attempt recorded. */
  | "skipped";

export interface EnhancementResult {
  /** Unchanged from the input on anything but `enhanced`. */
  readonly record: MemoryRecord;
  readonly outcome: EnhancementOutcome;
}

/** DD-006: determinism matters more than creativity here. */
const COMPRESSION_TEMPERATURE = 0;

export async function enhanceMemory(
  record: MemoryRecord,
  deps: ToolDeps,
  budgetMs: number = ENHANCEMENT_TIMEOUT_MS,
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
      return { record, outcome: "skipped" };
    }

    const compressed = await compress(content, deps, remaining(deadline));
    if (compressed === undefined) {
      await recordAttempt(record.id, deps);
      return { record, outcome: "degraded" };
    }

    summary = compressed.summary;
    tags = normalizeTags(record.tags, compressed.suggested_tags);
  }

  const embedded = await embed(summary, deps, remaining(deadline));

  // applyEnhancement sets status='compressed', so calling it with only a new
  // embedding would mark an uncompressed row compressed.
  if (!needsCompression && embedded === undefined) {
    await recordAttempt(record.id, deps);
    return { record, outcome: "degraded" };
  }

  const updated = await deps.store.applyEnhancement(record.id, {
    summary,
    tags,
    embedding: embedded?.vector ?? null,
    embeddingModel: embedded?.model ?? null,
  });

  if (updated === undefined) {
    // A forget landed mid-enhancement. Recording an attempt against a dead row
    // would be noise.
    deps.log.warn({ id: record.id }, "enhancement discarded: row no longer live");
    return { record, outcome: "skipped" };
  }

  if (updated.needsEmbedding) {
    await recordAttempt(record.id, deps);
    return { record: updated, outcome: "degraded" };
  }

  return { record: updated, outcome: "enhanced" };
}

/** `undefined` on any failure — compression is never fatal to the write (DD-005). */
async function compress(
  content: string,
  deps: ToolDeps,
  timeoutMs: number,
): Promise<{ summary: string; suggested_tags: string[] } | undefined> {
  if (timeoutMs <= 0) {
    deps.log.warn({ stage: "compress" }, "enhancement budget exhausted, leaving row raw");
    return undefined;
  }

  try {
    const raw = await deps.ollama.generate(buildCompressionPrompt(content), {
      format: compressionJsonSchema(),
      temperature: COMPRESSION_TEMPERATURE,
      timeoutMs,
    });
    return parseCompressionResult(raw);
  } catch (error: unknown) {
    // OLLAMA_UNAVAILABLE and OLLAMA_BAD_RESPONSE mean the same thing to the row.
    deps.log.warn(
      { stage: "compress", error: describeUnknown(error) },
      "compression failed, leaving row raw",
    );
    return undefined;
  }
}

async function embed(
  summary: string,
  deps: ToolDeps,
  timeoutMs: number,
): Promise<{ vector: readonly number[]; model: string } | undefined> {
  if (timeoutMs <= 0) {
    deps.log.warn({ stage: "embed" }, "enhancement budget exhausted, leaving row unembedded");
    return undefined;
  }

  try {
    const result = await deps.ollama.embed(summary, "document", { timeoutMs });
    // Re-checked at the last point before persistence: pgvector's own rejection
    // would arrive as an opaque insert failure rather than a named degradation.
    assertEmbeddingDimensions(result.vector, result.model);
    return { vector: result.vector, model: result.model };
  } catch (error: unknown) {
    deps.log.warn(
      { stage: "embed", error: describeUnknown(error) },
      "embedding failed, row keeps needs_embedding",
    );
    return undefined;
  }
}

/** Behind an already-durable write, so a failure costs one extra retry, nothing more. */
async function recordAttempt(id: string, deps: ToolDeps): Promise<void> {
  try {
    await deps.store.recordEnhancementAttempt(id);
  } catch (error: unknown) {
    deps.log.warn({ id, error: describeUnknown(error) }, "could not record enhancement attempt");
  }
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}
