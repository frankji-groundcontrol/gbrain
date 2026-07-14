/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });

  it('uses a clean home and no ambient embedding credentials', () => {
    const src = readFileSync(SHARD_SH, 'utf-8');
    expect(src).toMatch(/test_home=\$\(mktemp -d\)/);
    expect(src).toMatch(/env -u GBRAIN_HOME -u OPENAI_API_KEY -u DASHSCOPE_API_KEY/);
    expect(src).toMatch(/HOME="\$test_home" bun test/);
    expect(src).toContain('HOME="$test_home" git config --global --add safe.directory "$PWD"');
    expect(src).toContain('snapshot_opt_out=("${cold_bootstrap_files[@]}")');
    expect(src).toContain('cold_bootstrap_files=("test/bootstrap.test.ts"');
    expect(src).toContain('for f in "${cold_files[@]}"; do');
    expect(src).toContain('GBRAIN_SKIP_COLD_PGLITE_TESTS');
    expect(src).toContain('GBRAIN_TEST_FILES_PER_PROCESS');
  });
});
