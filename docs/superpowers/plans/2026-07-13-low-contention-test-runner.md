# Low-Contention Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default local unit-test run use one Bun worker instead of sixteen.

**Architecture:** Preserve existing operator overrides. Change the default shard count and per-shard Bun concurrency to one when no override is present, and pin both defaults with the existing script test.

**Tech Stack:** Bash, Bun test, TypeScript regression tests.

---

### Task 1: Lower the default test fan-out

**Files:**
- Modify: `test/scripts/run-unit-parallel.test.ts`
- Modify: `scripts/run-unit-parallel.sh:73`
- Modify: `docs/TESTING.md`

- [x] **Step 1: Write the failing regression test**

Add assertions to the existing `run-unit-parallel.sh` regression suite:

```ts
expect(readFileSync(PARALLEL_SH_SRC, 'utf-8')).toMatch(
  /GBRAIN_TEST_MAX_CONCURRENCY:-1/,
);
expect(readFileSync(PARALLEL_SH_SRC, 'utf-8')).toMatch(
  /N="\$\{SHARDS_OVERRIDE:-\$\{SHARDS:-1\}\}"/,
);
```

- [x] **Step 2: Run the regression test and verify it fails**

Run: `bun test test/scripts/run-unit-parallel.test.ts`

Expected: FAIL because the runner still derives the default shard count from
the host CPU count.

- [x] **Step 3: Change the runner default**

Replace this line in `scripts/run-unit-parallel.sh`:

```bash
N="${SHARDS_OVERRIDE:-${SHARDS:-$(detect_cpus)}}"
```

with:

```bash
N="${SHARDS_OVERRIDE:-${SHARDS:-1}}"
```

Remove the now-unused `detect_cpus` function and the default-only cap-to-four
block. Keep the existing explicit override cap of eight.

Also replace this line:

```bash
INTRA_CONC="${MAX_CONCURRENCY_OVERRIDE:-${GBRAIN_TEST_MAX_CONCURRENCY:-4}}"
```

with:

```bash
INTRA_CONC="${MAX_CONCURRENCY_OVERRIDE:-${GBRAIN_TEST_MAX_CONCURRENCY:-1}}"
```

Update `docs/TESTING.md` to describe the one-shard/one-worker default and
the `SHARDS` / `GBRAIN_TEST_MAX_CONCURRENCY` opt-in overrides.

- [x] **Step 4: Run focused verification**

Run: `bash -n scripts/run-unit-parallel.sh && bun test test/scripts/run-unit-parallel.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the default banner without running tests**

Run: `bash scripts/run-unit-parallel.sh --dry-run 2>&1`

Expected: banner begins with `[unit-parallel] N=1 shards | --max-concurrency=1`.

- [ ] **Step 6: Commit with the wider dedicated-schema change after its required gates pass**

```bash
git add scripts/run-unit-parallel.sh test/scripts/run-unit-parallel.test.ts \
  docs/superpowers/specs/2026-07-13-low-contention-test-runner.md \
  docs/superpowers/plans/2026-07-13-low-contention-test-runner.md
git commit -m "test: reduce default unit-test concurrency"
```

### Task 2: Reuse the PGLite schema snapshot

**Files:**
- Modify: `test/scripts/run-unit-parallel.test.ts`
- Modify: `test/scripts/run-unit-shard.test.ts`
- Modify: `scripts/run-unit-parallel.sh`
- Modify: `scripts/run-unit-shard.sh`
- Modify: `docs/TESTING.md`

- [x] **Step 1: Write failing script-contract tests**

Pin that the top-level runner builds and exports the snapshot only after a
dry-run check, and that the shard runner isolates its cold-bootstrap files:

```ts
expect(parallel).toContain('GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar');
expect(shard).toContain('snapshot_opt_out=("test/bootstrap.test.ts"');
```

- [x] **Step 2: Run the script-contract tests and verify they fail**

Run: `bun test test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts`

Expected: FAIL because the local runner does not yet export the snapshot or
split the cold-bootstrap files.

- [x] **Step 3: Build once and export the snapshot in the local wrapper**

After the `--dry-run` early exit in `scripts/run-unit-parallel.sh`, build the
gitignored snapshot with `bun run build:pglite-snapshot` when the real repo
contains the builder script, then export its path for child runners. Abort
before launching test shards if the build fails.

- [x] **Step 4: Isolate the cold-bootstrap files in the shard runner**

When `GBRAIN_PGLITE_SNAPSHOT` is set, direct shard callers run snapshot-
incompatible suites in their own Bun process without that variable. The local
wrapper skips only these four bootstrap-contract files, then runs ordinary
files from the snapshot:

```text
test/bootstrap.test.ts
test/destructive-guard.test.ts
test/pages-soft-delete.test.ts
test/schema-bootstrap-coverage.test.ts
```

- [x] **Step 5: Run focused verification**

Run: `bash -n scripts/run-unit-parallel.sh scripts/run-unit-shard.sh && bun test test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts`

Expected: PASS.

- [x] **Step 6: Benchmark one PGLite suite**

Run: `GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar bun test test/hybrid-meta.serial.test.ts`

Expected: PASS without `117 migration(s) applied`.

- [x] **Step 7: Bound local Bun process lifetime**

Pass `GBRAIN_TEST_FILES_PER_PROCESS=8` from the local wrapper. In the shard
runner, use the existing `run_files` helper once per normal snapshot-backed
batch. Docker CI uses the same eight-file lifecycle in each of its four
one-worker shards. Pin the batch setting in the runner regression tests.

- [x] **Step 8: Align the fixture with Bun's test configuration**

Build the snapshot with Bun's legacy 1536d test configuration, matching the
preload in `bunfig.toml`. Only `cold_bootstrap_files` bypass the snapshot;
the two deliberate pre-schema probes clear it around their one-off engines.
