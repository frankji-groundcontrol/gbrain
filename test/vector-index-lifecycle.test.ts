import { describe, expect, test } from 'bun:test';
import {
  chunkEmbeddingIndexSql,
  applyChunkEmbeddingIndexPolicy,
  PGVECTOR_HNSW_VECTOR_MAX_DIMS,
  checkActiveBuild,
  dropZombieIndexes,
  dropAndRebuild,
  isSupabaseAutoMaintenance,
  type ActiveBuildInfo,
  type IndexSpec,
} from '../src/core/vector-index.ts';

describe('chunkEmbeddingIndexSql — pre-v0.30.1 contract', () => {
  test('emits CREATE INDEX for dims ≤ 2000', () => {
    const sql = chunkEmbeddingIndexSql(1536);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
    expect(sql).toContain('hnsw');
  });

  test('emits skip-comment for dims > 2000 (Voyage 3072)', () => {
    const sql = chunkEmbeddingIndexSql(3072);
    expect(sql).toContain('skipped');
    expect(sql).not.toContain('CREATE INDEX');
  });

  test('boundary at exactly PGVECTOR_HNSW_VECTOR_MAX_DIMS (2000)', () => {
    const at = chunkEmbeddingIndexSql(PGVECTOR_HNSW_VECTOR_MAX_DIMS);
    expect(at).toContain('CREATE INDEX');
    const above = chunkEmbeddingIndexSql(PGVECTOR_HNSW_VECTOR_MAX_DIMS + 1);
    expect(above).toContain('skipped');
  });
});

describe('applyChunkEmbeddingIndexPolicy', () => {
  test('replaces the canonical index SQL', () => {
    const input = `BEFORE\nCREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);\nAFTER`;
    const out = applyChunkEmbeddingIndexPolicy(input, 1536);
    expect(out).toContain('idx_chunks_embedding');
    const out2 = applyChunkEmbeddingIndexPolicy(input, 3072);
    expect(out2).toContain('skipped');
  });
});

describe('checkActiveBuild', () => {
  test('PGLite returns active: false', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding', 'content_chunks');
    expect(r.active).toBe(false);
  });

  test('Postgres with no active builds returns active: false', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [],
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding', 'content_chunks');
    expect(r.active).toBe(false);
  });

  test('Postgres scopes active builds to the exact active-schema index and table', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [
          { pid: 12345, query: 'CREATE INDEX CONCURRENTLY idx_chunks_embedding ON content_chunks ...', application_name: 'gbrain' },
        ];
      },
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding', 'content_chunks');
    expect(r.active).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.application_name).toBe('gbrain');
    expect(capturedSql).toContain('pg_stat_progress_create_index');
    expect(capturedSql.match(/current_schema\(\)/g)?.length).toBe(2);
    expect(capturedSql).toContain('t.relname = $1');
    expect(capturedSql).toContain('i.relname = $2');
    expect(capturedParams).toEqual(['content_chunks', 'idx_chunks_embedding']);
  });

  test('query failure is unknown, not inactive', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => { throw new Error('permission denied'); },
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding', 'content_chunks');
    expect(r.active).toBe(false);
    expect(r.status).toBe('unknown');
  });
});

describe('isSupabaseAutoMaintenance', () => {
  test('true for application_name containing "supabase"', () => {
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'supabase-cron' })).toBe(true);
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'postgres-meta' })).toBe(true);
  });

  test('false for gbrain', () => {
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'gbrain-worker' })).toBe(false);
  });

  test('false when not active', () => {
    expect(isSupabaseAutoMaintenance({ active: false })).toBe(false);
  });
});

describe('dropZombieIndexes', () => {
  test('PGLite: no-op returns dropped: []', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });

  test('Postgres: no zombies returns dropped: []', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [],
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });

  test('Postgres: drops invalid indexes by exact schema-qualified name', async () => {
    const drops: string[] = [];
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_progress_create_index')) return []; // no active builds
        if (sql.includes('pg_index')) {
          return [
            { indexname: 'zombie_idx_a', tablename: 'content_chunks', drop_name: '"groundcontrol"."zombie_idx_a"' },
            { indexname: 'zombie_idx_b', tablename: 'pages', drop_name: '"groundcontrol"."zombie_idx_b"' },
          ];
        }
        if (sql.startsWith('DROP INDEX')) {
          drops.push(sql);
          return [];
        }
        return [];
      },
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual(['zombie_idx_a', 'zombie_idx_b']);
    expect(drops).toEqual([
      'DROP INDEX IF EXISTS "groundcontrol"."zombie_idx_a"',
      'DROP INDEX IF EXISTS "groundcontrol"."zombie_idx_b"',
    ]);
  });

  test('Postgres: skips zombie when active build present', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_progress_create_index')) {
          return [{ pid: 555, query: 'CREATE INDEX zombie_idx_a ...', application_name: 'gbrain' }];
        }
        if (sql.includes('pg_index')) {
          return [{ indexname: 'zombie_idx_a', tablename: 'content_chunks', drop_name: '"groundcontrol"."zombie_idx_a"' }];
        }
        return [];
      },
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });

  test('Postgres: query failure skips destructive zombie cleanup', async () => {
    const drops: string[] = [];
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_index')) {
          return [{ indexname: 'zombie_idx_a', tablename: 'content_chunks', drop_name: '"groundcontrol"."zombie_idx_a"' }];
        }
        if (sql.includes('pg_stat_progress_create_index')) throw new Error('permission denied');
        if (sql.startsWith('DROP INDEX')) drops.push(sql);
        return [];
      },
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
    expect(drops).toEqual([]);
  });
});

describe('dropAndRebuild — A3 atomic-swap', () => {
  test('PGLite: no-op returns rebuilt: false', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'test' });
    expect(r.rebuilt).toBe(false);
  });

  test('Postgres: bails when active build present (without --force)', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_progress_create_index')) {
          return [{ pid: 555, query: 'CREATE INDEX idx_chunks_embedding...', application_name: 'supabase' }];
        }
        return [];
      },
      withReservedConnection: async () => { throw new Error('should not be called'); },
      transaction: async () => { throw new Error('should not be called'); },
    } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'auto' });
    expect(r.rebuilt).toBe(false);
  });

  test('Postgres: query failure skips destructive rebuild even with force', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => { throw new Error('permission denied'); },
      withReservedConnection: async () => { throw new Error('should not be called'); },
      transaction: async () => { throw new Error('should not be called'); },
    } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    expect(await dropAndRebuild(fakeEngine, spec, { reason: 'test', force: true })).toEqual({
      rebuilt: false,
      tempName: spec.name,
    });
  });

  test('temp name format: <name>_rebuild_<unix-ms>', async () => {
    let executedSql = '';
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [], // no active build
      withReservedConnection: async (fn: any) => fn({
        executeRaw: async (sql: string) => {
          executedSql = sql;
          return [];
        },
      }),
      transaction: async (fn: any) => {
        // Provide a no-op tx with sql.unsafe.
        await fn({ sql: { unsafe: async () => [] } });
      },
    } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'test' });
    expect(r.rebuilt).toBe(true);
    expect(r.tempName).toMatch(/^idx_chunks_embedding_rebuild_\d+$/);
    expect(executedSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(executedSql).toContain(r.tempName);
  });
});
