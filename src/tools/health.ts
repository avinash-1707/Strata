import type { HealthInput, HealthOutput } from "../contracts/health.js";
import type { ToolDeps } from "../deps.js";
import { describeUnknown } from "../errors.js";

/**
 * Domain logic returns a contract value, never a surface's response type. That is
 * what lets MCP and HTTP share one implementation: each surface owns its own
 * rendering and error mapping, and neither can be reached from here.
 *
 * Phase 2 scaffolding. It retired protocol risk and proves `ToolDeps` injection, but
 * it is not product — see build-plan's debt note.
 */
export async function health(input: HealthInput, deps: ToolDeps): Promise<HealthOutput> {
  // Redis is not load-bearing: an unreachable cache degrades this to a null version
  // rather than failing the call (DD-005).
  let corpusVersion: number | null = null;
  try {
    corpusVersion = await deps.cache.getCorpusVersion();
  } catch (error: unknown) {
    deps.log.warn(
      { tool: "health", error: describeUnknown(error) },
      "corpus version unavailable, reporting cache down",
    );
  }

  return {
    corpus_version: corpusVersion,
    cache: corpusVersion === null ? "down" : "up",
    compaction_enabled: deps.config.COMPACTION_ENABLED,
    ...(input.echo === undefined ? {} : { echo: input.echo }),
  };
}
