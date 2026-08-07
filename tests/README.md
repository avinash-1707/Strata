# Tests

47 files, 740 tests, and a shell script that tries to break the architecture.
Everything here runs in about two seconds without any container, which is deliberate:
a suite that is slow to run is a suite that gets run less. With Postgres and Redis up,
the container-backed files stop skipping and the count is 846.

```bash
pnpm test                  # the full suite; container-backed files skip themselves
pnpm check                 # typecheck, lint, then the suite
./scripts/integration.sh   # brings up Postgres and Redis, unskips those files
./scripts/seamcheck.sh     # tries to violate every architectural boundary
```

## Layout

```
fakes/        injectable in-memory implementations of every seam
support/      shared harnesses: a recording logger, a stdio client, deterministic waits
store/        the storage conformance suite, run against fake and real
surfaces/     the same input through MCP and REST, results compared
```

The rest mirrors `src/` file for file.

## A guard counts only once it has been seen failing

This is the rule that shapes everything else here. Before any check is treated as
protection, the thing it protects is deliberately broken and the check is watched going
red. A test that passes against broken code is not a test, it is decoration, and the
difference is invisible until the day it matters.

Recent examples, each verified this way rather than assumed:

- sharing one MCP protocol server across requests
- removing the MCP path from the authentication middleware
- routing only POST to the MCP endpoint, so other methods fall through
- deleting the forced connection close during shutdown
- failing to clear the shutdown watchdog after a successful teardown
- dropping the cancellation signal before it reaches the model call
- dropping the between-rows abort check in the repair pass
- dropping the corpus version prefix from the recall cache key, which resurrects a
  forgotten memory from cache
- removing the usage update from the cache hit branch, which is what would make the
  most-recalled memories look coldest to compaction
- dropping the deleted-at filter from the live rows view
- dropping the tag index, and selecting compaction candidates on importance instead of
  usage, which is the predicate the original design specified

This discipline exists because the alternative already happened once here. A suite of
several hundred passing tests missed a critical invariant, because every assertion for
that invariant had been written around the code path that already worked.

## Watch out for the assertion that cannot fail

Seeing a check go red is necessary and not sufficient, because a check can go red for a
reason other than the one in its name. Two shapes have shown up here more than once,
and both were found by review rather than by the suite.

The first is the vacuous negative. `expect(results).not.toContain(forgotten)` is
satisfied by an empty list, so a delete that removed everything reads as a delete that
worked. Every such assertion here now carries a positive control: something that must
still be present.

The second is the shadowed predicate. A test named for one rule can be satisfied
entirely by a different one, leaving the rule it names untested and its implementation
deletable with the suite still green. That happened to the compaction eligibility
check: recording a recall also updates a timestamp, so the row was being excluded for
being too recent rather than for having been read, and the usage filter it claimed to
test was dead code. The fix is to neutralise every other rule first, so only the one
under test can produce the result.

## Fakes, not mocks

Tool tests run against fake implementations of the storage, cache, and model seams.
They are real implementations with real behaviour, not recorded call expectations, and
they can be told to fail, to block until released, or to go down entirely. Asserting on
observable outcomes rather than on which internal method was called is what lets the
implementation change without a hundred tests changing with it.

The fakes can simulate:

- a whole service being unreachable
- one method failing while the rest work, which is a genuinely different situation
- a call blocking until the test releases it, which proves concurrency without timing
- a model returning malformed output, prose-wrapped JSON, or nothing at all

## One contract, tested twice

`store/conformance.ts` is the storage contract written as behavioural assertions,
parameterised by a factory. It runs unmodified against the in-memory fake and against
real Postgres in a container.

This matters more than it sounds. A fake that has drifted from the database it stands
in for does not merely fail to catch bugs, it actively certifies wrong behaviour: every
fast test agrees with a model of the world that the real system does not share. Running
one suite against both is what keeps the fake honest, and the suite is not permitted to
be edited to accommodate a divergence. When the two disagree, the fake is wrong.

## Surface equivalence

`surfaces/equivalence.test.ts` sends the same input through MCP and through REST and
compares the results. The two surfaces are supposed to be thin wrappers over one
implementation, and this is the check that says so out loud rather than trusting the
layering to hold.

## Seam probes

`scripts/seamcheck.sh` is not a test file, but it belongs in the same argument. It runs
49 probes across the architectural boundaries. 34 plant an import that a boundary
forbids and fail if the linter accepts it. The other 15 plant a legal import and fail
if the linter rejects it, because a rule that blocks everything is not a rule, it is a
broken configuration that looks like rigour.

An earlier version of the lint configuration shared a base block across boundaries, and
the per directory additions silently discarded it. Every boundary looked configured and
several enforced nothing. That was found by this script and by nothing else.

## Determinism

Pure logic and fake-backed tests contain no timers and no sleeps. Where a test needs to
wait for something, it drains microtasks until a condition holds rather than sleeping
for a plausible interval, so the outcome cannot depend on how loaded the machine is.

The exceptions are the two suites that bind a real socket or spawn a real process,
where waiting on the operating system is the entire point. Those wait on an observable
event, such as the line the server logs when it has bound, rather than on a duration.

## What each layer proves

| Layer | Dependencies | What a failure means |
| --- | --- | --- |
| Pure logic | none | Fusion, parsing, or hashing is wrong |
| Tool logic | fakes | A domain rule broke, independent of infrastructure |
| Store conformance | fake and real Postgres | The fake drifted, or the SQL is wrong |
| Surface tests | fakes | MCP and REST have diverged |
| Protocol tests | a real MCP client | Wire framing or transport lifecycle is wrong |
| Socket tests | a real listener | Binding, shutdown, or draining is wrong |
| Seam probes | the linter | An architectural boundary stopped being enforced |
