import { describe, expect, it } from "vitest";

import type { Cluster } from "../../eval/corpus.js";
import {
  DOCUMENTS,
  EVAL_K,
  QUERIES,
  crudeStem,
  significantTokens,
} from "../../eval/corpus.js";

/**
 * The eval corpus is an instrument, and an instrument that flatters the system is
 * worse than none: every phase gate from 6 to 11 is a comparison of numbers it
 * produces. These are the properties that make those numbers discriminating, and
 * they are checked here because prose in the corpus header cannot enforce them.
 *
 * This suite needs no database and no model — it is the part of DD-021 that can be
 * trusted before the hardware exists.
 */

const byId = new Map(DOCUMENTS.map((document) => [document.id, document]));

function documentsIn(cluster: Cluster): readonly string[] {
  return DOCUMENTS.filter((document) => document.cluster === cluster).map((d) => d.id);
}

describe("eval corpus: structural integrity", () => {
  it("has unique document ids and unique query ids", () => {
    expect(new Set(DOCUMENTS.map((d) => d.id)).size).toBe(DOCUMENTS.length);
    expect(new Set(QUERIES.map((q) => q.id)).size).toBe(QUERIES.length);
  });

  it("has no duplicate document text — a duplicate would be a second correct answer", () => {
    const contents = DOCUMENTS.map((d) => d.content.trim().toLowerCase());
    expect(new Set(contents).size).toBe(DOCUMENTS.length);
  });

  it("points every query at documents that exist", () => {
    for (const query of QUERIES) {
      expect(query.relevant.length).toBeGreaterThan(0);
      for (const id of query.relevant) {
        expect(byId.has(id), `${query.id} references missing document ${id}`).toBe(true);
      }
    }
  });

  /* Invariant 1. With a cluster of `k` or fewer, retrieving the right subject fills
     the whole result set and every query in it scores a free hit — the ranker's
     ordering is never tested. */
  it("keeps every cluster larger than k", () => {
    for (const cluster of ["storage", "cache", "api", "deploy"] as const) {
      expect(documentsIn(cluster).length, `cluster ${cluster}`).toBeGreaterThan(EVAL_K);
    }
  });

  it("spreads each session across clusters, so a session filter is not a topic filter", () => {
    const clustersPerSession = new Map<string, Set<Cluster>>();
    for (const document of DOCUMENTS) {
      const seen = clustersPerSession.get(document.sessionId) ?? new Set<Cluster>();
      seen.add(document.cluster);
      clustersPerSession.set(document.sessionId, seen);
    }
    expect(clustersPerSession.size).toBeGreaterThan(1);
    for (const [session, clusters] of clustersPerSession) {
      expect(clusters.size, `session ${session}`).toBeGreaterThan(1);
    }
  });

  it("covers all three query kinds in every cluster", () => {
    for (const cluster of ["storage", "cache", "api", "deploy"] as const) {
      const kinds = new Set(QUERIES.filter((q) => q.cluster === cluster).map((q) => q.kind));
      expect(kinds, `cluster ${cluster}`).toEqual(new Set(["semantic", "lexical", "hybrid"]));
    }
  });
});

/* Invariant 2. These queries are the whole reason the semantic arm has to prove
   itself: if one shares a content word with its answer, `ts_rank_cd` can find it and
   a broken embedding path — the DD-008 prefix bug, say — stops being visible. */
describe("eval corpus: semantic queries share no word with their answer", () => {
  for (const query of QUERIES.filter((q) => q.kind === "semantic")) {
    it(`${query.id} has no lexical route to its answer`, () => {
      const asked = significantTokens(query.text);
      for (const id of query.relevant) {
        const answer = significantTokens(byId.get(id)!.content);
        const shared = [...asked].filter((token) => answer.has(token));
        expect(shared, `${query.id} shares "${shared.join(", ")}" with ${id}`).toEqual([]);
      }
    });
  }

  /* Not enough that the query misses its answer lexically — it has to *hit*
     something else, or a lexical ranker returns nothing and the query degenerates
     into a test of the semantic arm alone rather than a contest between them. */
  it("still overlaps the distractors, so a lexical ranker is misled rather than silent", () => {
    for (const query of QUERIES.filter((q) => q.kind === "semantic")) {
      const asked = significantTokens(query.text);
      const decoys = DOCUMENTS.filter(
        (document) => !query.relevant.includes(document.id),
      ).filter((document) => {
        const tokens = significantTokens(document.content);
        return [...asked].some((token) => tokens.has(token));
      });
      expect(decoys.length, `${query.id} misleads nothing`).toBeGreaterThan(0);
    }
  });
});

/* Invariant 3. An anchor present in two documents makes the query ambiguous; an
   anchor absent from the query text makes it unreachable. Either way the arm that
   exists to catch exact identifiers is measured against something else. */
describe("eval corpus: lexical anchors are unique and reachable", () => {
  for (const query of QUERIES.filter((q) => q.kind === "lexical")) {
    it(`${query.id} turns on a token only its answer carries`, () => {
      const anchor = query.anchor;
      expect(anchor, `${query.id} is lexical but declares no anchor`).toBeDefined();
      const stem = crudeStem(anchor!.toLowerCase());

      expect(
        significantTokens(query.text).has(stem),
        `${query.id} does not contain its own anchor "${anchor!}"`,
      ).toBe(true);

      const carriers = DOCUMENTS.filter((document) =>
        significantTokens(document.content).has(stem),
      ).map((document) => document.id);
      expect([...carriers].sort()).toEqual([...query.relevant].sort());
    });
  }

  it("declares an anchor only where it means something", () => {
    for (const query of QUERIES.filter((q) => q.kind !== "lexical")) {
      expect(query.anchor, `${query.id} declares an unused anchor`).toBeUndefined();
    }
  });
});

describe("eval corpus: the tokenizer the invariants rest on", () => {
  it("stems toward over-matching, because Postgres stems too", () => {
    expect(crudeStem("timeouts")).toBe(crudeStem("timeout"));
    expect(crudeStem("partitioned")).toBe(crudeStem("partition"));
    expect(crudeStem("indexes")).toBe(crudeStem("index"));
  });

  it("keeps identifiers whole so an anchor survives tokenization", () => {
    const tokens = significantTokens("what does pg_advisory_xact_lock protect? allkeys-lru too");
    expect(tokens.has("pg_advisory_xact_lock")).toBe(true);
    expect(tokens.has("allkeys-lru")).toBe(true);
  });

  it("drops stopwords rather than counting them as overlap", () => {
    expect(significantTokens("why did the job hang").has("the")).toBe(false);
  });
});
