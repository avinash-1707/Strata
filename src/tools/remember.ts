import { RAW_SUMMARY_LENGTH } from "../config/budgets.js";
import type { RememberInput, RememberOutput } from "../contracts/remember.js";
import type { ToolDeps } from "../deps.js";
import { contentHash } from "../hash.js";
import type { MemoryRecord } from "../store/types.js";
import { normalizeTags } from "../tags.js";
import { bumpCorpusVersion } from "./corpus.js";
import { enhanceMemory } from "./enhance.js";

/**
 * DD-005: durability first. Everything up to and including the insert fails loud;
 * everything after it degrades. Failing this call because Ollama was slow is the
 * exact bug DD-005 exists to prevent.
 */
export async function remember(input: RememberInput, deps: ToolDeps): Promise<RememberOutput> {
  const hash = contentHash(input.content);

  const existing = await deps.store.findLiveByContentHash(hash);
  if (existing !== undefined) {
    // DD-020. No version bump: nothing changed, so no cached recall is stale.
    deps.log.info({ tool: "remember", id: existing.id }, "duplicate content, returning existing");
    return toOutput(existing);
  }

  const inserted = await deps.store.insertRaw({
    summary: input.content.slice(0, RAW_SUMMARY_LENGTH),
    rawContent: input.content,
    contentHash: hash,
    tags: normalizeTags(input.tags),
    sessionId: input.session_id ?? null,
  });

  await bumpCorpusVersion(deps, "remember");

  const { record } = await enhanceMemory(inserted, deps);
  return toOutput(record);
}

function toOutput(record: MemoryRecord): RememberOutput {
  return {
    id: record.id,
    summary: record.summary,
    tags: [...record.tags],
    status: record.status,
  };
}
