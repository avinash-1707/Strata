# Retrieval evaluation

A search system without a scoreboard is a search system nobody can improve. Every
constant in the retrieval path, the fusion dampener, the index search width, the
candidate budget, has a defensible argument behind it and no evidence. This directory
exists to replace the arguments with numbers.

```bash
pnpm eval
```

## What it does

The harness seeds a purpose-built corpus into its own database, runs a fixed set of
queries through four different retrieval strategies, scores each one, and compares
them. It exits non-zero if a comparison that should hold does not.

```
corpus.ts    48 documents, 24 queries, and the properties that make them discriminating
metrics.ts   recall@k and MRR, pure, and they refuse to score an unscoreable run
run.ts       seeds, runs four arms, prints the table, enforces the gates
```

## The corpus

48 short documents in four clusters of twelve: storage, cache, api, and deploy. Each
cluster is larger than the number of results a query asks for, which is the point.
Retrieving the right document from a pool of eight is not evidence of anything;
retrieving it from twelve near neighbours on the same topic is.

24 queries in three classes, eight each:

- **semantic**, which share no stemmed word with the document that answers them, so
  keyword search cannot solve them by accident
- **lexical**, each anchored on an exact identifier that appears in exactly one
  document, which similarity search tends to smear across a cluster
- **hybrid**, which need both signals

The corpus is deliberately written to make these three classes separable. A retrieval
strategy that scores well on all three is doing two different things well, rather than
one thing well and getting lucky.

## The invariants are tested, not asserted in prose

Those properties are enforced by `tests/eval/corpus.test.ts`, not by a comment asking
future editors to preserve them. Written as prose they rot the first time somebody
rewords a document.

The guard paid for itself immediately. It caught five semantic-class queries that
shared a word with their own answer. Each one would have let keyword search solve a
query specifically written to be unsolvable by it, quietly inflating the exact
comparison that proves semantic search is contributing anything.

## The four arms

| Arm | What it is | What it proves |
| --- | --- | --- |
| exact | Brute force cosine, index scans priced out | The ground truth ceiling |
| semantic | The real indexed vector path | Whether the index costs recall |
| lexical | Postgres full text search | What keywords alone can reach |
| hybrid | Fusion of lexical and semantic | Whether combining them beats either |

The exact arm carries its own SQL rather than calling the production search function
with the index disabled. This is not duplication for its own sake. The indexed path is
the thing under test, so grading it against itself with one setting changed measures
self-consistency, not recall.

The same principle applies in the other direction to `scripts/`, which is forbidden by
lint from importing `src/` at all: a script written to check whether the application's
assumptions match reality cannot import the code holding those assumptions, or it will
agree with itself no matter what reality says.

## The gates

The harness does not print numbers and leave the interpretation to a human in a hurry.
It asserts relationships and fails the run when one does not hold:

1. Indexed semantic recall is at least as good as exact recall. If the approximate
   index is silently dropping relevant rows, this is the only thing that would say so.
2. Semantic recall beats lexical recall on the semantic query class. If it does not,
   embeddings are contributing nothing and the vector half of the system is decoration.
3. Hybrid recall beats semantic recall alone. Fusion that does not improve on the
   better of its two inputs is misconfigured, and every other measurement taken
   through it is suspect.

`metrics.ts` refuses rather than defaults. A run with zero judgements, or a query with
no relevant document, throws. Every gate is a comparison of two numbers, and a gate
satisfied by an empty run is worse than no gate at all.

## Isolation

Each run drops and rebuilds its own database, and refuses to start if that name
resolves to the configured application database. The seed step is the most
harmless-looking part of an evaluation harness and the one most capable of truncating
real data.

The evaluation database is left behind after a run rather than cleaned up, so a number
that looks wrong can be investigated against the exact rows that produced it.

## A finding

The lexical arm needs no model, so its numbers were real on the first run.

Postgres builds full text queries with AND semantics. Given a natural language
question, that means every content word must appear in the matching document:

```
websearch_to_tsquery('english', 'what does pg_advisory_xact_lock protect?')
  -> 'pg' <-> 'advisori' <-> 'xact' <-> 'lock' & 'protect'
```

The document containing `pg_advisory_xact_lock` does not contain the word "protect", so
it does not match. **Lexical recall@8 on exactly the queries designed for the lexical
arm was 37.5%.** The three that did match were short enough that the stopword list ate
everything except the identifier.

AND semantics were chosen for good reasons, precision and safe handling of quoted
phrases. The cost is that the arm works only when a question's content words all happen
to appear in its answer, which is common for a keyword and rare for a question. The
candidate fixes are cheap and obvious enough to be tempting to just pick one, which is
precisely why the harness now exists to choose between them.
