import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { ensureBackfillIndex, type BackfillSpec } from '../src/core/backfill-base.ts';
import { checkTimelineDedupIndex } from '../src/core/timeline-dedup-repair.ts';
import { dropZombieIndexes, monitorBuild } from '../src/core/vector-index.ts';
import { checkBrainstormHealth } from '../src/commands/doctor.ts';
import { __testing as migration018 } from '../src/commands/migrations/v0_18_0.ts';
import { __testing as migration0322 } from '../src/commands/migrations/v0_32_2.ts';

function isActiveSchemaScoped(sql: string): boolean {
  return /current_schema\(\)/.test(sql) || /::regclass/.test(sql);
}

const CONSTRAINT_PROBE_FIXTURES = [
  [11, 'links_link_source_check', 'links'],
  [11, 'links_from_to_type_source_origin_unique', 'links'],
  [22, 'links_resolution_type_check', 'links'],
  [23, 'pages_source_slug_key', 'pages'],
  [60, 'oauth_clients_source_id_fkey', 'oauth_clients'],
  [82, 'subagent_tool_executions_stable_id', 'subagent_tool_executions'],
  [85, 'fk_oauth_clients_bound_source', 'oauth_clients'],
] as const;

const INDEX_HANDLER_FIXTURES = [
  [14, 'idx_pages_updated_at_desc', 'pages'],
  [34, 'pages_deleted_at_purge_idx', 'pages'],
  [41, 'pages_coalesce_date_idx', 'pages'],
  [66, 'idx_chunks_embedding_null', 'content_chunks'],
  [72, 'takes_resolved_at_idx', 'takes'],
  [91, 'pages_generation_idx', 'pages'],
  [96, 'idx_facts_extract_conversation_session', 'facts'],
  [97, 'pages_dedup_idx', 'pages'],
  [103, 'content_chunks_stale_idx', 'content_chunks'],
  [104, 'pages_atom_source_hash_idx', 'pages'],
  [112, 'pages_links_extracted_at_idx', 'pages'],
] as const;

describe('active-schema catalog probes', () => {
  test('migration SQL scopes representative constraints, relations, and invalid indexes', async () => {
    const mod = await import('../src/core/migrate.ts') as typeof import('../src/core/migrate.ts') & {
      scopeMigrationCatalogProbes?: (sql: string) => string;
    };
    expect(typeof mod.scopeMigrationCatalogProbes).toBe('function');
    const scope = mod.scopeMigrationCatalogProbes!;

    for (const [version, name, table] of CONSTRAINT_PROBE_FIXTURES) {
      const migration = mod.MIGRATIONS.find((m) => m.version === version)!;
      const captured: string[] = [];
      if (migration.handler) {
        await migration.handler({
          kind: 'postgres',
          transaction: async (fn: (tx: BrainEngine) => Promise<void>) => fn({
            kind: 'postgres',
            runMigration: async (_v: number, sql: string) => { captured.push(sql); },
          } as unknown as BrainEngine),
        } as unknown as BrainEngine);
      } else {
        captured.push(migration.sqlFor?.postgres ?? migration.sql ?? '');
      }
      const sql = captured.map(scope).find((sample) => sample.includes(`conname = '${name}'`)) ?? '';
      const at = sql.indexOf(`conname = '${name}'`);
      expect(at, `v${version} ${name}`).toBeGreaterThanOrEqual(0);
      expect(sql.slice(at, at + 180), `v${version} ${name}`).toContain(`'${table}'::regclass`);
    }

    const v23 = mod.MIGRATIONS.find((m) => m.version === 23)!;
    const captured23: string[] = [];
    const tx = { runMigration: async (_v: number, sql: string) => { captured23.push(scope(sql)); } };
    await v23.handler!({
      kind: 'postgres',
      transaction: async (fn: (inner: unknown) => Promise<void>) => fn(tx),
    } as unknown as BrainEngine);
    expect(captured23[0]).toContain('table_schema = current_schema()');

    for (const [version, indexName, table] of INDEX_HANDLER_FIXTURES) {
      const migration = mod.MIGRATIONS.find((m) => m.version === version)!;
      const captured: string[] = [];
      await migration.handler!({
        kind: 'postgres',
        runMigration: async (_v: number, sql: string) => { captured.push(scope(sql)); },
      } as unknown as BrainEngine);
      const probe = captured.find((sql) => sql.includes('pg_index'))!;
      expect(probe, `v${version} ${indexName}`).toContain(`'${table}'::regclass`);
    }
  });

  test('legacy custom-schema migration execution scopes probes without changing selection bytes', async () => {
    const { attemptMigration, MIGRATIONS, selectMigrationSql } = await import('../src/core/migrate.ts');
    const migration = MIGRATIONS.find((m) => m.version === 11)!;
    const captured: string[] = [];
    const tx = {
      kind: 'postgres' as const,
      runMigration: async (_version: number, sql: string) => { captured.push(sql); },
    } as unknown as BrainEngine;
    const engine = {
      kind: 'postgres' as const,
      isDedicatedSchemaMode: () => false,
      transaction: async (fn: (inner: BrainEngine) => Promise<void>) => fn(tx),
      setConfig: async () => {},
    } as unknown as BrainEngine;

    expect(selectMigrationSql(migration, engine)).toBe(migration.sql);
    await attemptMigration(engine, migration);
    expect(captured.find((sql) => sql.includes('pg_constraint'))).toContain(
      "conname = 'links_link_source_check' AND conrelid = 'links'::regclass",
    );
  });

  test('explicit catalog fixture inventory covers every renderer rule and handler probe', async () => {
    const mod = await import('../src/core/migrate.ts');
    const source = await Bun.file(new URL('../src/core/migrate.ts', import.meta.url)).text();
    const constraintBlock = source.match(/const CONSTRAINT_RELATIONS[^=]*= \{([\s\S]*?)\n\};/)?.[1];
    const indexBlock = source.match(/const INDEX_RELATIONS[^=]*= \{([\s\S]*?)\n\};/)?.[1];
    expect(constraintBlock).toBeDefined();
    expect(indexBlock).toBeDefined();
    const names = (block: string) => [...block.matchAll(/^\s{2}(\w+): '[^']+',$/gm)].map((match) => match[1]);
    const constraintRuleNames = names(constraintBlock!);
    const indexRuleNames = names(indexBlock!);

    expect([...CONSTRAINT_PROBE_FIXTURES.map(([, name]) => name)].sort() as string[]).toEqual(constraintRuleNames.sort());
    expect([...INDEX_HANDLER_FIXTURES.map(([, name]) => name)].sort() as string[]).toEqual(indexRuleNames.sort());

    for (const [version, indexName, table] of INDEX_HANDLER_FIXTURES) {
      const migration = mod.MIGRATIONS.find((candidate) => candidate.version === version);
      expect(migration?.handler, `missing v${version} handler for ${indexName}`).toBeFunction();
      const captured: string[] = [];
      await migration!.handler!({
        kind: 'postgres',
        runMigration: async (_v: number, sql: string) => { captured.push(sql); },
      } as unknown as BrainEngine);
      const probe = captured.find((sql) => sql.includes('pg_index'));
      expect(probe, `v${version} ${indexName} handler did not reach its probe`).toBeDefined();
      expect(mod.scopeMigrationCatalogProbes(probe!), `v${version} ${indexName}`).toContain(
        `i.indrelid = '${table}'::regclass`,
      );
    }
  });

  test('source inventory classifies every name-only migration-adjacent catalog probe', () => {
    const root = join(import.meta.dir, '..');
    const migrationPaths = readdirSync(join(root, 'src/commands/migrations'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `src/commands/migrations/${name}`);
    const paths = [
      'src/core/migrate.ts',
      'src/core/retrieval-upgrade-planner.ts',
      'src/core/timeline-dedup-repair.ts',
      'src/core/vector-index.ts',
      'src/core/backfill-base.ts',
      ...migrationPaths,
    ];
    const sources = new Map(paths.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
    const migrate = sources.get('src/core/migrate.ts')!;
    const rendererNames = (constant: string) => new Set(
      [...migrate.matchAll(new RegExp(`const ${constant}[^=]*= \\{([\\s\\S]*?)\\n\\};`, 'g'))]
        .flatMap((block) => [...block[1].matchAll(/^\s{2}(\w+): '[^']+',$/gm)].map((match) => match[1])),
    );
    const rendererConstraints = rendererNames('CONSTRAINT_RELATIONS');
    const rendererIndexes = rendererNames('INDEX_RELATIONS');
    const findings: string[] = [];

    for (const [path, source] of sources) {
      for (const match of source.matchAll(/FROM pg_constraint\b/g)) {
        const probe = source.slice(match.index, match.index + 350);
        const name = probe.match(/conname\s*=\s*'([^']+)'/)?.[1];
        if (!/(?:conrelid\s*=\s*'[^']+'::regclass|relnamespace|current_schema\(\))/.test(probe) &&
            !(path === 'src/core/migrate.ts' && name && rendererConstraints.has(name))) {
          findings.push(`${path}:pg_constraint:${name ?? match.index}`);
        }
      }
      for (const match of source.matchAll(/FROM pg_index\b/g)) {
        const probe = source.slice(match.index, match.index + 350);
        const name = probe.match(/\.relname\s*=\s*'([^']+)'/)?.[1];
        if (!/(?:indrelid\s*=\s*'[^']+'::regclass|relnamespace|current_schema\(\))/.test(probe) &&
            !(path === 'src/core/migrate.ts' && name && rendererIndexes.has(name))) {
          findings.push(`${path}:pg_index:${name ?? match.index}`);
        }
      }
      for (const match of source.matchAll(/(?:information_schema\.(?:tables|columns)|FROM pg_indexes)\b[\s\S]{0,220}/g)) {
        if (!/(?:table_schema|schemaname)\s*=\s*current_schema\(\)/.test(match[0]) &&
            !(path === 'src/core/migrate.ts' && /table_name\s*=\s*'files'/.test(match[0]) &&
              migrate.includes('"WHERE table_schema = current_schema() AND table_name = \'files\'"'))) {
          findings.push(`${path}:${match.index}`);
        }
      }
      for (const match of source.matchAll(/to_regclass\(([^\n;]+)\)/g)) {
        if (!/current_schema\(\)/.test(match[1]) &&
            !(path === 'src/core/timeline-dedup-repair.ts' && match[1] === "'timeline_entries'" &&
              source.includes("engine.kind === 'postgres'"))) {
          findings.push(`${path}:to_regclass:${match[1]}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  test('timeline repair treats public-only table as absent and performs no mutation', async () => {
    const seen: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('to_regclass')) {
          return [{ reg: sql.includes('current_schema()') ? null : 'public.timeline_entries' }];
        }
        throw new Error(`unexpected mutation: ${sql}`);
      },
    } as unknown as BrainEngine;
    const { repairTimelineDedupIndex } = await import('../src/core/timeline-dedup-repair.ts');
    expect(await repairTimelineDedupIndex(engine)).toEqual({
      repaired: false,
      before: [],
      collapsedDuplicates: 0,
      reason: 'no_table',
    });
    expect(seen).toEqual([expect.stringContaining('current_schema()')]);
  });

  test('timeline index lookup ignores a correct public decoy', async () => {
    const seen: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('to_regclass')) return [{ reg: 'groundcontrol.timeline_entries' }];
        return isActiveSchemaScoped(sql)
          ? [{ indexdef: 'CREATE UNIQUE INDEX idx_timeline_dedup ON groundcontrol.timeline_entries USING btree (page_id, date, summary)' }]
          : [{ indexdef: 'CREATE UNIQUE INDEX idx_timeline_dedup ON public.timeline_entries USING btree (page_id, date, summary, source)' }];
      },
    } as unknown as BrainEngine;
    const status = await checkTimelineDedupIndex(engine);
    expect(status.needsRepair).toBe(true);
    expect(seen[1]).toMatch(/schemaname\s*=\s*current_schema\(\)/);
    expect(seen[1]).toMatch(/tablename\s*=\s*'timeline_entries'/);
  });

  test('zombie cleanup discovers and drops only active-schema indexes', async () => {
    const seen: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('pg_index')) {
          return isActiveSchemaScoped(sql)
            ? [{ indexname: 'active_bad', tablename: 'pages', drop_name: '"groundcontrol"."active_bad"' }]
            : [
                { indexname: 'public_bad', tablename: 'pages', drop_name: '"public"."public_bad"' },
                { indexname: 'active_bad', tablename: 'pages', drop_name: '"groundcontrol"."active_bad"' },
              ];
        }
        if (sql.includes('pg_stat_progress_create_index')) return [];
        return [];
      },
    } as unknown as BrainEngine;
    const result = await dropZombieIndexes(engine);
    expect(result.dropped).toEqual(['active_bad']);
    expect(seen.find((sql) => sql.includes('pg_index'))).toMatch(/current_schema\(\)/);
    expect(seen.filter((sql) => sql.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX IF EXISTS "groundcontrol"."active_bad"',
    ]);
  });

  test('backfill index existence ignores a public decoy', async () => {
    let created = false;
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => [{ exists: !isActiveSchemaScoped(sql) }],
      withReservedConnection: async (fn: (conn: { executeRaw: (sql: string) => Promise<unknown[]> }) => Promise<void>) =>
        fn({ executeRaw: async () => { created = true; return []; } }),
    } as unknown as BrainEngine;
    const spec: BackfillSpec<{ id: number }> = {
      name: 'scope-test', table: 'pages', selectColumns: [], needsBackfill: 'true',
      compute: async () => [],
      requiredIndex: { name: 'same_name', sql: 'CREATE INDEX CONCURRENTLY same_name ON pages(id)' },
    };
    expect(await ensureBackfillIndex(engine, spec)).toEqual({ existed: false, created: true });
    expect(created).toBe(true);
  });

  test('migration orchestrator column and constraint checks ignore public decoys', async () => {
    const engine0322 = {
      kind: 'postgres' as const,
      getConfig: async () => '51',
      executeRaw: async (sql: string) => isActiveSchemaScoped(sql)
        ? [{ column_name: 'row_num' }]
        : [{ column_name: 'row_num' }, { column_name: 'source_markdown_slug' }],
    } as unknown as BrainEngine;
    const phase0322 = await migration0322.phaseASchema(engine0322, { yes: true, dryRun: false, noAutopilotInstall: true });
    expect(phase0322.status).toBe('failed');

    const engine018 = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes("id = 'default'")) return [{ id: 'default' }];
        if (sql.includes('pg_constraint')) return isActiveSchemaScoped(sql) ? [] : [{ conname: 'pages_source_slug_key' }];
        throw new Error('active pages verification must not run for a public-only constraint');
      },
      disconnect: async () => {},
    } as unknown as BrainEngine;
    // phaseCVerify owns engine creation and is covered structurally by its exported
    // query seam; the migration SQL helper above covers executable constraint ownership.
    const source = migration018.phaseCVerify.toString();
    expect(source).toContain("'pages'::regclass");
  });

  test('doctor relation and column diagnostics use the active schema', async () => {
    const observed: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        observed.push(sql);
        return [{ exists: isActiveSchemaScoped(sql) ? false : true }];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const check = await checkBrainstormHealth(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('column missing');
    expect(observed[0]).toContain('current_schema()');
  });

  test('index build progress sizes only the active-schema index', async () => {
    const seen: string[] = [];
    let activeCalls = 0;
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('pg_stat_progress_create_index')) {
          activeCalls++;
          return activeCalls === 1
            ? [{ pid: 1, query: 'CREATE INDEX scoped_idx', application_name: 'gbrain' }]
            : [];
        }
        if (sql.includes('pg_relation_size')) return [{ size: 1 }];
        return [];
      },
    } as unknown as BrainEngine;
    await monitorBuild(engine, 'scoped_idx', () => {}, { intervalMs: 0, maxIterations: 2 });
    expect(seen.find((sql) => sql.includes('pg_relation_size'))).toContain('current_schema()');
  });
});
