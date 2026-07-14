# Low-Contention Test Runner Design

## Goal

Limit the default local unit-test fan-out to one Bun worker so
normal verification does not saturate developer CPU, disk, or network.

## Decision

Change both default dimensions to one: one shard and one Bun worker. Build
the existing PGLite snapshot once for a real local run, then pass it to normal
test files so each in-memory engine restores post-migration state instead of
replaying the schema. Run normal local files in small Bun-process batches so
PGLite/WASM memory cannot accumulate indefinitely. The snapshot uses Bun's legacy 1536d
test configuration; the four bootstrap-contract files are excluded from the
local loop but remain in CI. Normal local files run in batches of eight: this
releases PGLite/WASM memory regularly without restoring the 44 MB snapshot for
every file. `SHARDS`, `GBRAIN_TEST_MAX_CONCURRENCY`,
`GBRAIN_TEST_FILES_PER_PROCESS`, and their command-line overrides remain
available for operator tuning.

## Scope

Modify the local parallel wrapper, unit-shard runner, Docker CI unit command,
their existing script tests, and the testing guide. Explicit overrides remain
unchanged.

## Verification

Regression tests must prove the one-shard/one-worker and eight-file-batch
defaults, normal local files receive the snapshot, the snapshot's legacy
embedding width, and bootstrap-contract files do not run locally. Run the
runner tests, a dry-run invocation, and representative snapshot and cold-init
benchmarks.
