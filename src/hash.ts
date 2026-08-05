import { createHash } from "node:crypto";

/**
 * DD-020's idempotency key, over the content exactly as the caller sent it.
 *
 * Deliberately unnormalized: "exact duplicate" is the whole of DD-020's scope, and
 * trimming or case-folding here would be a half-step toward near-duplicate
 * detection — which DD-023 defers until a threshold can be measured on real data.
 * A half-measure is worse than either end, because it changes what counts as a
 * duplicate without any evidence for the new line.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
