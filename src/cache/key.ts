import { createHash } from "node:crypto";

import type { RecallKey } from "./types.js";

/**
 * The one place a recall cache key is built, shared by the Redis client and the
 * in-memory fake so they cannot drift.
 *
 * The corpus version is a *prefix*, not part of the hash: every mutation `INCR`s
 * it, which makes every prior key unreachable at once and lets stale entries die
 * on their own TTL — no key scanning, no reverse index, no invalidation logic to
 * get wrong (DD-010).
 *
 * `k`, `synthesize`, and `sessionId` are all inside the hash because leaving them
 * out was a real defect: keying on the query alone let `k=8` collide with `k=50`,
 * and let a `synthesize: false` call be served a cached `answer`.
 */
export function composeRecallKey(corpusVersion: number, key: RecallKey): string {
  const parts = [
    normalizeQuery(key.query),
    String(key.k),
    key.synthesize ? "syn" : "raw",
    key.sessionId ?? "",
  ];
  // A separator that survives normalization but cannot occur in any part, so
  // k=1 with session "2" cannot hash to the same tuple as k=12 with no session.
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
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
