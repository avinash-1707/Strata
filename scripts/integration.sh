#!/usr/bin/env bash
# Brings up the dev Postgres/Redis stack, runs the full test suite with the
# integration env set (which un-skips the container-backed tests), and tears the
# stack down again — from a trap, so a failed run still cleans up (DD-030).
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT="${STRATA_PG_PORT:-54329}"
REDIS_PORT="${STRATA_REDIS_PORT:-63790}"

cleanup() {
  docker compose down -v --remove-orphans
}
trap cleanup EXIT

docker compose up -d --wait

# Serialized: the container-backed files share one database, and parallel
# workers truncating it under each other would fail tests for the wrong reason.
STRATA_TEST_PG_URL="postgres://strata:strata@127.0.0.1:${PG_PORT}/strata" \
STRATA_TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
pnpm exec vitest run --no-file-parallelism "$@"
