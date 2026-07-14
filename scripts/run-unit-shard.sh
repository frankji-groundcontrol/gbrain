#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# M-th file starting at index N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to fan 4 unit-shard workers in parallel inside
# the runner container, each pinned to its own postgres shard for the
# downstream E2E phase.
#
# Docker CI batches a shard in one Bun process. The local wrapper uses small
# batches so PGLite/WASM memory is released before it accumulates.

set -euo pipefail

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
MAX_CONC=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

FILES_PER_PROCESS="${GBRAIN_TEST_FILES_PER_PROCESS:-}"
if [ -n "$FILES_PER_PROCESS" ] && \
   { ! printf '%s' "$FILES_PER_PROCESS" | grep -qE '^[1-9][0-9]*$'; }; then
  echo "ERROR: GBRAIN_TEST_FILES_PER_PROCESS must be a positive integer" >&2
  exit 2
fi

# These suites intentionally construct empty PGLite databases. The local
# wrapper excludes them to keep the edit loop resource-safe; direct shard
# callers (including Docker CI) retain full coverage.
cold_bootstrap_files=("test/bootstrap.test.ts"
  "test/destructive-guard.test.ts"
  "test/pages-soft-delete.test.ts"
  "test/schema-bootstrap-coverage.test.ts")

# The snapshot matches Bun's legacy 1536d test preload. Only bootstrap suites
# need a whole-file empty database rather than a post-migration restore.
snapshot_opt_out=("${cold_bootstrap_files[@]}")

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      files+=("$f")
    fi
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

if [ "${GBRAIN_SKIP_COLD_PGLITE_TESTS:-}" = "1" ]; then
  selected=()
  for f in "${files[@]}"; do
    cold=0
    for opt_out in "${cold_bootstrap_files[@]}"; do
      [ "$f" = "$opt_out" ] && cold=1 && break
    done
    [ "$cold" = "0" ] && selected+=("$f")
  done
  files=("${selected[@]}")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[unit-shard ${SHARD:-(unsharded)}] running ${#files[@]} files"
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT
# CI runs as root against a host-owned bind mount. The test HOME is isolated,
# so seed its Git allow-list instead of inheriting the runner's global config.
HOME="$test_home" git config --global --add safe.directory "$PWD"

snapshot_files=()
cold_files=()
if [ -n "${GBRAIN_PGLITE_SNAPSHOT:-}" ]; then
  for f in "${files[@]}"; do
    cold=0
    for opt_out in "${snapshot_opt_out[@]}"; do
      [ "$f" = "$opt_out" ] && cold=1 && break
    done
    if [ "$cold" = "1" ]; then
      cold_files+=("$f")
    else
      snapshot_files+=("$f")
    fi
  done
else
  snapshot_files=("${files[@]}")
fi

# Tests must not inherit a developer's configured brain or provider keys.
# Keep one fresh HOME per shard; fixture tests configure any credentials they
# need explicitly.
run_bun_test() {
  env -u GBRAIN_HOME -u OPENAI_API_KEY -u DASHSCOPE_API_KEY -u ANTHROPIC_API_KEY \
    -u GOOGLE_GENERATIVE_AI_API_KEY -u VOYAGE_API_KEY -u ZEROENTROPY_API_KEY \
    -u JINA_API_KEY -u MISTRAL_API_KEY -u COHERE_API_KEY \
    HOME="$test_home" bun test "$@"
}

run_cold_bun_test() {
  env -u GBRAIN_HOME -u GBRAIN_PGLITE_SNAPSHOT -u OPENAI_API_KEY -u DASHSCOPE_API_KEY -u ANTHROPIC_API_KEY \
    -u GOOGLE_GENERATIVE_AI_API_KEY -u VOYAGE_API_KEY -u ZEROENTROPY_API_KEY \
    -u JINA_API_KEY -u MISTRAL_API_KEY -u COHERE_API_KEY \
    HOME="$test_home" bun test "$@"
}

run_files() {
  local runner="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  if [ -n "$MAX_CONC" ]; then
    "$runner" --max-concurrency="$MAX_CONC" --timeout=60000 "$@"
  else
    "$runner" --timeout=60000 "$@"
  fi
}

for f in "${cold_files[@]}"; do
  run_files run_cold_bun_test "$f"
done
if [ -n "$FILES_PER_PROCESS" ]; then
  # Keep PGLite/WASM heaps bounded without restoring the 44 MB snapshot once
  # per file. Local and Docker CI both use this bounded batch lifecycle.
  batch=()
  for f in "${snapshot_files[@]}"; do
    batch+=("$f")
    if [ "${#batch[@]}" -eq "$FILES_PER_PROCESS" ]; then
      run_files run_bun_test "${batch[@]}"
      batch=()
    fi
  done
  run_files run_bun_test "${batch[@]}"
else
  run_files run_bun_test "${snapshot_files[@]}"
fi
