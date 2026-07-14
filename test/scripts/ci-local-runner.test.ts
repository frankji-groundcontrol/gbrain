import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('ci-local omits empty worktree mount arguments', () => {
  const script = readFileSync(join(import.meta.dir, '../../scripts/ci-local.sh'), 'utf8');
  expect(script).toContain('run --rm "${EXTRA_MOUNTS[@]}" runner bash -c "$INNER_CMD"');
  expect(script).not.toContain('"${EXTRA_MOUNTS[@]:-}"');
});

test('ci-local limits four-shard unit work to one worker and eight files per process', () => {
  const script = readFileSync(join(import.meta.dir, '../../scripts/ci-local.sh'), 'utf8');
  expect(script).toContain(
    'env -u DATABASE_URL GBRAIN_TEST_FILES_PER_PROCESS=8 SHARD=\\${shard}/4 bash scripts/run-unit-shard.sh --max-concurrency=1',
  );
  expect(script).not.toContain('GBRAIN_TEST_ISOLATE_FILES=1');
  expect(script.match(/2>\\\\&1/g)?.length).toBe(3);
});

test('ci-local allows schema-drift to reset its CI test database', () => {
  const script = readFileSync(join(import.meta.dir, '../../scripts/ci-local.sh'), 'utf8');
  expect(script.match(/GBRAIN_TEST_DB=1/g)?.length).toBe(2);
});
