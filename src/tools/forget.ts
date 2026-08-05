import type {
  ForgetInput,
  ForgetOutput,
  RestoreInput,
  RestoreOutput,
} from "../contracts/forget.js";
import type { ToolDeps } from "../deps.js";
import { bumpCorpusVersion } from "./corpus.js";

/**
 * DD-012: a soft delete. The row is retained with `deleted_at` set, which is what
 * makes `restore` possible and bounds the blast radius (DD-039).
 */
export async function forget(input: ForgetInput, deps: ToolDeps): Promise<ForgetOutput> {
  const deleted = await deps.store.softDelete(input.id);

  // Only on a real change: an unknown id leaves every cached recall valid.
  if (deleted) {
    await bumpCorpusVersion(deps, "forget");
  }

  return { deleted };
}

/**
 * DD-039. The bump is not optional bookkeeping: a restored memory is visible again,
 * so any cached recall that omitted it is stale.
 */
export async function restore(input: RestoreInput, deps: ToolDeps): Promise<RestoreOutput> {
  const restored = await deps.store.restore(input.id);

  if (restored) {
    await bumpCorpusVersion(deps, "restore");
  }

  return { restored };
}
