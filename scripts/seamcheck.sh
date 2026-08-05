#!/bin/zsh
# Verifies the module seams in eslint.config.js by planting one violating import per
# case and checking that eslint actually rejects it. Every plant is removed again.
#
# This exists because the seam rules are the kind of check that fails silently. Two
# separate bugs were found only by running it: single-segment globs that missed
# `store/pg/lexical.js`, and flat config *replacing* an overlapping rule so that
# per-directory blocks discarded the shared one.
#
# Run after any change to eslint.config.js or to the directory layout:
#   ./scripts/seamcheck.sh
set -e
cd /Users/avinash/code/projects/Strata

# Counted, and the script exits non-zero if any probe disagrees. Without this the
# whole suite printed FAIL and still exited 0, so `pnpm seamcheck` could not fail a
# build — a guard that cannot fail is not a guard.
FAILURES=0

probe() {
  local file="$1" import="$2" label="$3" expect="$4"
  mkdir -p "$(dirname "$file")"
  local existed=0
  if [[ -f "$file" ]]; then existed=1; cp "$file" "$file.seambak"; fi
  printf 'import type * as Probe from "%s";\nexport type P = typeof Probe;\n' "$import" > "$file.tmp"
  if [[ $existed == 1 ]]; then cat "$file.seambak" >> "$file.tmp"; fi
  mv "$file.tmp" "$file"

  if pnpm exec eslint "$file" --rule '{}' >/dev/null 2>&1; then
    got="ALLOWED"
  else
    if pnpm exec eslint "$file" 2>&1 | grep -q "no-restricted-imports"; then got="BLOCKED"; else got="ALLOWED"; fi
  fi

  if [[ $existed == 1 ]]; then mv "$file.seambak" "$file"; else rm -f "$file"; fi

  if [[ "$got" == "$expect" ]]; then
    echo "  ok   $label -> $got"
  else
    echo "  FAIL $label -> $got (expected $expect)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "inbound: who may import src/db"
probe src/store/pg/probe.ts        ../../db/types.js       "store/pg -> db"      ALLOWED
probe src/store/probe.ts           ../db/types.js          "store -> db"         BLOCKED
probe src/search/probe.ts          ../db/types.js          "search -> db"        BLOCKED
probe src/mcp/tools/probe.ts       ../../db/types.js       "tools -> db"         BLOCKED
probe src/cache/probe.ts           ../db/types.js          "cache -> db"         BLOCKED
probe src/ollama/probe.ts          ../db/types.js          "ollama -> db"        BLOCKED
probe src/probe.ts                 ./db/types.js           "src root -> db"      BLOCKED

echo "outbound: mutual isolation"
probe src/cache/probe.ts           ../ollama/types.js      "cache -> ollama"     BLOCKED
probe src/cache/probe.ts           ../store/types.js       "cache -> store"      BLOCKED
probe src/ollama/probe.ts          ../cache/types.js       "ollama -> cache"     BLOCKED
probe src/ollama/probe.ts          ../store/types.js       "ollama -> store"     BLOCKED
probe src/db/probe.ts              ../cache/types.js       "db -> cache"         BLOCKED
probe src/store/pg/probe.ts        ../../ollama/types.js   "store/pg -> ollama"  BLOCKED
probe src/store/pg/probe.ts        ../../cache/types.js    "store/pg -> cache"   BLOCKED
probe src/store/probe.ts           ../ollama/types.js      "store -> ollama"     BLOCKED

echo "deep paths (the shallow-glob bug)"
probe src/cache/probe.ts           ../store/pg/index.js    "cache -> store/pg"   BLOCKED
probe src/mcp/tools/probe.ts       ../../store/pg/index.js "tools -> store/pg"   BLOCKED
probe src/mcp/tools/probe.ts       ../../../tests/fakes/fakeDeps.js "mcp -> fake" BLOCKED

echo "permitted"
probe src/mcp/tools/probe.ts       ../../store/types.js    "tools -> MemoryStore" ALLOWED
# A real module, deliberately. This pointed at ../../contracts.js, which stopped
# existing when contracts became a directory — and since an unresolvable import still
# reports ALLOWED, the probe passed while testing nothing.
probe src/mcp/tools/probe.ts       ../../contracts/remember.js "tools -> contracts" ALLOWED
probe src/store/pg/probe.ts        ../types.js             "store/pg -> store"    ALLOWED

echo "new surfaces (tools must not reach a surface; http == mcp restrictions)"
probe src/tools/probe.ts     ../mcp/invoke.js        "tools -> mcp"         BLOCKED
probe src/tools/probe.ts     ../http/app.js          "tools -> http"        BLOCKED
probe src/tools/probe.ts     ../db/types.js          "tools -> db"          BLOCKED
probe src/tools/probe.ts     ../store/pg/index.js    "tools -> store/pg"    BLOCKED
probe src/http/probe.ts      ../db/types.js          "http -> db"           BLOCKED
probe src/http/probe.ts      ../store/pg/index.js    "http -> store/pg"     BLOCKED
probe src/http/probe.ts      ../mcp/invoke.js        "http -> mcp"          BLOCKED
probe src/mcp/probe.ts       ../http/app.js          "mcp -> http"          BLOCKED
probe src/tools/probe.ts     ../store/types.js       "tools -> MemoryStore" ALLOWED
probe src/tools/probe.ts     ../deps.js              "tools -> ToolDeps"    ALLOWED
probe src/http/probe.ts      ../tools/health.js      "http -> tools"        ALLOWED
probe src/mcp/probe.ts       ../tools/health.js      "mcp -> tools"         ALLOWED

echo "jobs (a background job composes tools; it is not a surface)"
probe src/jobs/probe.ts   ../db/types.js          "jobs -> db"         BLOCKED
probe src/jobs/probe.ts   ../store/pg/index.js    "jobs -> store/pg"   BLOCKED
probe src/jobs/probe.ts   ../mcp/invoke.js        "jobs -> mcp"        BLOCKED
probe src/jobs/probe.ts   ../http/app.js          "jobs -> http"       BLOCKED
probe src/jobs/probe.ts   ../tools/enhance.js     "jobs -> tools"      ALLOWED
probe src/jobs/probe.ts   ../deps.js              "jobs -> ToolDeps"   ALLOWED
probe src/jobs/probe.ts   ../store/types.js       "jobs -> MemoryStore" ALLOWED

echo "production must not import test fakes"
probe src/tools/probe.ts  ../../tests/fakes/fakeStore.js  "tools -> fake"  BLOCKED
probe src/http/probe.ts   ../../tests/fakes/fakeDeps.js   "http -> fake"   BLOCKED
probe src/store/probe.ts  ../../tests/fakes/fakeStore.js  "store -> fake"  BLOCKED
probe src/jobs/probe.ts   ../../tests/fakes/fakeDeps.js   "jobs -> fake"   BLOCKED

if (( FAILURES > 0 )); then
  echo "\n$FAILURES seam probe(s) disagreed with the expected verdict."
  exit 1
fi
echo "\nall seam probes agreed."
