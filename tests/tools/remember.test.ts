import { describe, expect, it } from "vitest";

import { ENHANCEMENT_RETRY_POLICY, RAW_SUMMARY_LENGTH } from "../../src/config/budgets.js";
import { StrataError, isStrataError } from "../../src/errors.js";
import { contentHash } from "../../src/hash.js";
import { enhanceMemory } from "../../src/tools/enhance.js";
import { remember } from "../../src/tools/remember.js";
import type { FakeDeps, FakeDepsOptions } from "../fakes/fakeDeps.js";
import { createFakeDeps } from "../fakes/fakeDeps.js";
import { createRecordingLogger } from "../support/recordingLogger.js";
import type { RecordingLogger } from "../support/recordingLogger.js";
import { until } from "../support/until.js";

const CONTENT = "We chose pgvector over Qdrant because the corpus is small and Postgres is already here.";

function withLog(options: FakeDepsOptions = {}): { deps: FakeDeps; log: RecordingLogger } {
  const log = createRecordingLogger();
  return { deps: createFakeDeps({ ...options, log }), log };
}

describe("remember: the durable commit (DD-005 stage 1)", () => {
  it("stores and compresses when everything works", async () => {
    const deps = createFakeDeps();
    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("compressed");
    expect(stored.summary).toBe("A fake compressed summary.");
    expect(stored.id).not.toBe("");
  });

  it("retains the original content, not just the summary", async () => {
    const deps = createFakeDeps();
    const stored = await remember({ content: CONTENT }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    // DD-004: compression is lossy, so discarding the original would make a bad
    // summary permanent.
    expect(row?.rawContent).toBe(CONTENT);
  });

  /* Twice, deliberately: the durable insert is one visible mutation and the
     enhancement that replaces the summary and adds the vector is another. They are
     separated by seconds of model calls, so a recall landing between them caches a
     result carrying the raw placeholder summary and no embedding (DD-010). */
  it("bumps the corpus version for the insert and again for the enhancement (DD-010)", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 7 } });
    await remember({ content: CONTENT }, deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(9);
  });

  it("bumps only once when the enhancement degrades", async () => {
    const deps = createFakeDeps({
      cache: { initialVersion: 7 },
      ollama: { generate: "unavailable" },
    });
    await remember({ content: CONTENT }, deps);

    // Nothing was rewritten, so nothing cached is stale beyond the insert itself.
    await expect(deps.cache.getCorpusVersion()).resolves.toBe(8);
  });

  /* The insert must precede every model call, or an Ollama outage can lose a write. */
  it("inserts before calling the model", async () => {
    const deps = createFakeDeps();
    await remember({ content: CONTENT }, deps);

    const insertAt = deps.store.calls.indexOf("insertRaw");
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(deps.ollama.generateCalls.length).toBeGreaterThan(0);
    // applyEnhancement is the only store write that can follow a model call.
    expect(deps.store.calls.indexOf("applyEnhancement")).toBeGreaterThan(insertAt);
  });

  it("fails loud when Postgres is down — a lost write is worse than a failed call", async () => {
    const deps = createFakeDeps({ store: { down: true } });

    await expect(remember({ content: CONTENT }, deps)).rejects.toSatisfy(
      (error: unknown) => isStrataError(error) && error.code === "DB_QUERY_FAILED",
    );
  });

  it("uses a truncated placeholder summary until compression lands", async () => {
    const long = "x".repeat(RAW_SUMMARY_LENGTH + 500);
    const { deps } = withLog({ ollama: { generate: "unavailable" } });

    const stored = await remember({ content: long }, deps);

    expect(stored.summary).toHaveLength(RAW_SUMMARY_LENGTH);
    expect(stored.status).toBe("raw");
  });
});

describe("remember: Ollama is not load-bearing (DD-005)", () => {
  /* The DD-005 guarantee, and the reason the write path was reordered. */
  it("still succeeds with a fake Ollama that throws on every call", async () => {
    const { deps, log } = withLog({ ollama: { embed: "unavailable", generate: "unavailable" } });

    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("raw");
    expect(stored.id).not.toBe("");
    // The content is preserved verbatim, so the repair pass has something to work on.
    expect(stored.summary).toBe(CONTENT.slice(0, RAW_SUMMARY_LENGTH));
    expect(log.messages("warn")).toContain("compression failed, leaving row raw");
  });

  it("leaves the row live and in the backlog when the model is down", async () => {
    const deps = createFakeDeps({ ollama: { embed: "unavailable", generate: "unavailable" } });
    const stored = await remember({ content: CONTENT }, deps);

    const backlog = await deps.store.findEnhancementBacklog(10, ENHANCEMENT_RETRY_POLICY);
    expect(backlog.map((row) => row.id)).toContain(stored.id);
  });

  it.each(["prose", "wrongFields", "truncatedJson", "empty"] as const)(
    "keeps the row at raw for malformed output: %s",
    async (mode) => {
      const deps = createFakeDeps({ ollama: { generate: mode } });

      const stored = await remember({ content: CONTENT }, deps);

      expect(stored.status).toBe("raw");
      expect(deps.store.rows).toHaveLength(1);
    },
  );

  /* Prose *containing* balanced JSON is the case a first-brace-to-last-brace parser
     gets wrong, so it must still succeed rather than degrade. */
  it("recovers a fenced JSON payload wrapped in commentary", async () => {
    const deps = createFakeDeps({ ollama: { generate: "fencedJson" } });

    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("compressed");
    expect(stored.summary).toBe("A fake compressed summary.");
  });

  it("compresses but keeps needs_embedding when the embedding is the wrong width", async () => {
    const { deps, log } = withLog({ ollama: { embed: "wrongDimensions" } });

    const stored = await remember({ content: CONTENT }, deps);

    // Compression succeeded, so the summary is real; only the vector is missing.
    expect(stored.status).toBe("compressed");
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.needsEmbedding).toBe(true);
    expect(log.messages("warn")).toContain("embedding failed, row keeps needs_embedding");
  });

  it("rejects a non-finite embedding component rather than letting pgvector fail", async () => {
    const deps = createFakeDeps({ ollama: { embed: "nonFinite" } });

    const stored = await remember({ content: CONTENT }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.needsEmbedding).toBe(true);
    expect(stored.status).toBe("compressed");
  });

  it("counts a failed enhancement so the repair pass cannot retry it forever (DD-041)", async () => {
    // Content the model mangles, not an outage: only the former is evidence
    // against the row, and only the former is charged an attempt (DD-045).
    const deps = createFakeDeps({ ollama: { generate: "wrongFields" } });
    const stored = await remember({ content: CONTENT }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.enhancementAttempts).toBe(1);
    expect(row?.lastAttemptAt).toBeInstanceOf(Date);
  });

  /* The Phase 4 defect DD-045 names: an Ollama restart used to burn an attempt on
     every row written during it, and five such minutes stranded a memory at
     status:'raw' forever — invisible to semantic recall, with no error anywhere. */
  it("charges no attempt when the model was merely unreachable (DD-045)", async () => {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });
    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("raw");
    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.enhancementAttempts).toBe(0);
    expect(row?.lastAttemptAt).toBeNull();
  });

  it("does not count an attempt when everything succeeded", async () => {
    const deps = createFakeDeps();
    const stored = await remember({ content: CONTENT }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.enhancementAttempts).toBe(0);
  });
});

describe("remember: Redis is not load-bearing", () => {
  it("stores successfully and warns when the version bump fails", async () => {
    const { deps, log } = withLog({ cache: { down: true } });

    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("compressed");
    expect(log.messages("warn")).toContain(
      "corpus version bump failed, cached recalls may be stale",
    );
  });
});

describe("remember: exact-duplicate idempotency (DD-020)", () => {
  it("returns the existing id for identical content", async () => {
    const deps = createFakeDeps();

    const first = await remember({ content: CONTENT }, deps);
    const second = await remember({ content: CONTENT }, deps);

    expect(second.id).toBe(first.id);
    expect(deps.store.rows).toHaveLength(1);
  });

  it("does not call the model again for a duplicate", async () => {
    const deps = createFakeDeps();

    await remember({ content: CONTENT }, deps);
    const callsAfterFirst = deps.ollama.generateCalls.length;
    await remember({ content: CONTENT }, deps);

    expect(deps.ollama.generateCalls).toHaveLength(callsAfterFirst);
  });

  it("does not bump the corpus version for a duplicate — nothing changed", async () => {
    const deps = createFakeDeps({ cache: { initialVersion: 1 } });

    await remember({ content: CONTENT }, deps);
    const afterFirst = await deps.cache.getCorpusVersion();
    await remember({ content: CONTENT }, deps);

    await expect(deps.cache.getCorpusVersion()).resolves.toBe(afterFirst);
  });

  /* Deliberately unnormalized: DD-020 is exact-match only, and near-duplicate
     detection waits for a measured threshold (DD-023). */
  it("treats whitespace- and case-different content as distinct", async () => {
    const deps = createFakeDeps();

    const first = await remember({ content: CONTENT }, deps);
    const spaced = await remember({ content: `${CONTENT} ` }, deps);
    const cased = await remember({ content: CONTENT.toUpperCase() }, deps);

    expect(new Set([first.id, spaced.id, cased.id]).size).toBe(3);
  });

  it("lets forgotten content be remembered again", async () => {
    const deps = createFakeDeps();
    const first = await remember({ content: CONTENT }, deps);
    await deps.store.softDelete(first.id);

    const second = await remember({ content: CONTENT }, deps);

    // A *live*-row lookup, which is why the unique index in migration 001 is partial.
    expect(second.id).not.toBe(first.id);
  });

  it("matches on a hash of the content, not on the summary", async () => {
    const deps = createFakeDeps();
    const stored = await remember({ content: CONTENT }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.contentHash).toBe(contentHash(CONTENT));
  });
});

describe("remember: tags", () => {
  it("merges caller tags with model suggestions, normalized", async () => {
    const deps = createFakeDeps({
      ollama: { compression: { summary: "s", suggested_tags: ["#Postgres", "connection pooling"] } },
    });

    const stored = await remember({ content: CONTENT, tags: ["  Auth "] }, deps);

    expect(stored.tags).toContain("auth");
    expect(stored.tags).toContain("postgres");
    expect(stored.tags).toContain("connection-pooling");
  });

  it("keeps caller tags when compression fails", async () => {
    const deps = createFakeDeps({ ollama: { generate: "unavailable" } });

    const stored = await remember({ content: CONTENT, tags: ["Auth", "auth", "AUTH"] }, deps);

    // Normalized and deduped at insert, not only at enhancement.
    expect(stored.tags).toEqual(["auth"]);
  });

  it("scopes to a session when one is given (DD-018)", async () => {
    const deps = createFakeDeps();

    const stored = await remember({ content: CONTENT, session_id: "conv-1" }, deps);

    const row = deps.store.rows.find((candidate) => candidate.id === stored.id);
    expect(row?.sessionId).toBe("conv-1");
  });
});

describe("remember: a forget landing mid-enhancement", () => {
  it("does not resurrect the row, and does not fail the call", async () => {
    const { deps, log } = withLog();
    // Holding applyEnhancement guarantees the durable insert already committed, so
    // the delete lands in exactly the window that makes applyEnhancement return
    // undefined.
    const release = deps.store.block("applyEnhancement");

    const pending = remember({ content: CONTENT }, deps);
    await until(
      () => deps.store.calls.includes("applyEnhancement"),
      "enhancement reached the store",
    );

    const inserted = deps.store.rows[0];
    expect(inserted).toBeDefined();
    await deps.store.softDelete(inserted!.id);
    release();

    const stored = await pending;

    expect(stored.status).toBe("raw");
    expect(log.messages("warn")).toContain("enhancement discarded: row no longer live");
    const row = deps.store.rows.find((candidate) => candidate.id === inserted!.id);
    expect(row?.deletedAt).not.toBeNull();
  });
});

describe("enhancement: the stage-2 budget", () => {
  /* The budget is the reason a slow model degrades instead of holding the agent. An
     exhausted budget must decline to start the call, not run it unbounded. */
  it("declines to compress once the budget is spent", async () => {
    const { deps, log } = withLog();
    const [row] = deps.store.seed([{ summary: "s", status: "raw" }]);

    const result = await enhanceMemory(row!, deps, 0);

    // Deferred, not degraded: the row was never shown to the model, so nothing was
    // learned about its content and nothing may be charged to it (DD-045).
    expect(result.outcome).toBe("deferred");
    expect(result.record.status).toBe("raw");
    expect(deps.ollama.generateCalls).toEqual([]);
    expect(deps.store.rows[0]?.enhancementAttempts).toBe(0);
    expect(log.messages("warn")).toContain("enhancement budget exhausted, leaving row raw");
  });

  it("declines to embed once the budget is spent, keeping the row compressed", async () => {
    const { deps, log } = withLog();
    const [row] = deps.store.seed([
      { summary: "already compressed", status: "compressed", needsEmbedding: true },
    ]);

    const result = await enhanceMemory(row!, deps, 0);

    expect(result.outcome).toBe("deferred");
    expect(deps.store.rows[0]?.enhancementAttempts).toBe(0);
    expect(deps.ollama.embedCalls).toEqual([]);
    expect(log.messages("warn")).toContain(
      "enhancement budget exhausted, leaving row unembedded",
    );
  });

  it("skips a row that needs nothing", async () => {
    const deps = createFakeDeps();
    const [row] = deps.store.seed([
      { summary: "done", status: "compressed", needsEmbedding: false },
    ]);

    const result = await enhanceMemory(row!, deps);

    expect(result.outcome).toBe("skipped");
    expect(deps.ollama.generateCalls).toEqual([]);
    expect(deps.ollama.embedCalls).toEqual([]);
  });

  it("cannot compress a row whose raw content is gone, and counts the attempt", async () => {
    const { deps, log } = withLog();
    const [row] = deps.store.seed([{ summary: "s", status: "raw", rawContent: null }]);

    const result = await enhanceMemory(row!, deps);

    expect(result.outcome).toBe("degraded");
    expect(log.messages("warn")).toContain("cannot compress: raw content absent");
    /* Counted even though retrying cannot help. The backlog matches on status='raw',
       so without the counter this row holds a slot in every pass forever — DD-041's
       starvation reached by a different arm. */
    expect(deps.store.rows[0]?.enhancementAttempts).toBe(1);
  });

  it("embeds a compressed row without re-compressing it", async () => {
    const deps = createFakeDeps();
    const [row] = deps.store.seed([
      { summary: "already compressed", status: "compressed", needsEmbedding: true },
    ]);

    const result = await enhanceMemory(row!, deps);

    expect(result.outcome).toBe("enhanced");
    expect(deps.ollama.generateCalls).toEqual([]);
    expect(result.record.summary).toBe("already compressed");
    expect(result.record.needsEmbedding).toBe(false);
  });

  it("embeds the summary as a document, never as a query (DD-008)", async () => {
    const deps = createFakeDeps();
    await remember({ content: CONTENT }, deps);

    expect(deps.ollama.embedCalls.map((call) => call.kind)).toEqual(["document"]);
  });
});

describe("remember: bookkeeping failures do not surface", () => {
  it("serves the write when the attempt counter cannot be recorded", async () => {
    const { deps, log } = withLog({ ollama: { generate: "wrongFields" } });
    deps.store.setFailure(
      "recordEnhancementAttempt",
      new StrataError("DB_QUERY_FAILED", "boom"),
    );

    const stored = await remember({ content: CONTENT }, deps);

    expect(stored.status).toBe("raw");
    expect(log.messages("warn")).toContain("could not record enhancement attempt");
  });
});
