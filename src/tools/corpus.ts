import type { ToolDeps } from "../deps.js";
import { describeUnknown } from "../errors.js";

/**
 * DD-010: every mutation bumps the version, which is what makes stale recall keys
 * unreachable. Redis is not load-bearing, so a failure degrades to a warning — at
 * the documented cost of cached recalls staying stale until their TTL.
 */
export async function bumpCorpusVersion(deps: ToolDeps, tool: string): Promise<void> {
  try {
    await deps.cache.bumpCorpusVersion();
  } catch (error: unknown) {
    deps.log.warn(
      { tool, error: describeUnknown(error) },
      "corpus version bump failed, cached recalls may be stale",
    );
  }
}
