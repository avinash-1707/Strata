import { createHash } from "node:crypto";

import type { RecallKey } from "./types.js";

/**
 * The one place a recall cache key is built, shared by the Redis client and the fake
 * so they cannot drift (DD-010).
 *
 * The version is a *prefix*, not hashed: `INCR` then makes every prior key
 * unreachable at once, with no scanning and no reverse index. `k`, `synthesize`, and
 * `sessionId` are inside the hash because omitting them let `k=8` collide with
 * `k=50` and served a cached `answer` to `synthesize: false`.
 */
export function composeRecallKey(corpusVersion: number, key: RecallKey): string {
  const parts = [
    normalizeQuery(key.query),
    String(key.k),
    key.synthesize ? "syn" : "raw",
    key.sessionId ?? "",
  ];
  // Length-prefixed, not separator-joined. `query` and `sessionId` are caller
  // strings, so no separator is unforgeable: with a plain delimiter a caller can
  // move it into a part and make two distinct tuples hash alike.
  const canonical = parts.map((part) => `${String(part.length)}:${part}`).join("");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `recall:v${String(corpusVersion)}:${digest}`;
}

/**
 * Trivially different queries should share an entry, so the hash is taken over a
 * canonical form rather than the raw text (DD-010).
 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** The Redis key holding the corpus version counter (DD-010). */
export const CORPUS_VERSION_KEY = "strata:corpus:v";
