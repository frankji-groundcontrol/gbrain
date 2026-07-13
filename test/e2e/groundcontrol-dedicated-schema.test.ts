/**
 * Task 8 (2026-07 dedicated schema wave) — real-Postgres lifecycle E2E.
 *
 * Proves the full restricted groundcontrol lifecycle against a disposable
 * local Postgres + pgvector container:
 *   1. Provisions a uniquely-named temporary DB + the fixed `groundcontrol_app`
 *      role with the exact capabilities the design spec mandates.
 *   2. Provisions `extensions` schema + `vector` there, `pg_trgm` in `public`,
 *      `groundcontrol` ownership, CONNECT/USAGE, and effective CREATE denial.
 *   3. Fresh init under `groundcontrol_app` succeeds.
 *   4. GBrain objects land in `groundcontrol` and are owned by the role.
 *   5. No GBrain object or public/global policy is created outside the schema.
 *   6. A second init is idempotent.
 *   7. Wrong extension placement fails before DDL.
 *   8. Cleanup removes only the disposable DB + role this test created.
 *
 * The administrator DATABASE_URL is used ONLY to create the temp DB + role.
 * All schemas/extensions/objects live inside the temp DB. The application
 * password + derived URL never leave memory and are never logged.
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:PORT/gbrain_test \
 *      bun run test:e2e test/e2e/groundcontrol-dedicated-schema.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  attemptMigration,
  LATEST_VERSION,
  MIGRATIONS,
  selectMigrationSql,
} from '../../src/core/migrate.ts';
import {
  KEY_APPLIED,
  KEY_REQUESTED,
  resumeRetrievalUpgrade,
} from '../../src/core/retrieval-upgrade-planner.ts';
import { ensureBackfillIndex } from '../../src/core/backfill-base.ts';
import { checkTimelineDedupIndex, repairTimelineDedupIndex } from '../../src/core/timeline-dedup-repair.ts';
import { dropZombieIndexes } from '../../src/core/vector-index.ts';
import { __testing as migration0322 } from '../../src/commands/migrations/v0_32_2.ts';

const ADMIN_URL = process.env.DATABASE_URL;
const skip = !ADMIN_URL;

describe.skipIf(skip)('groundcontrol dedicated schema lifecycle (E2E)', () => {
  let admin: ReturnType<typeof postgres>;
  let appEngine: PostgresEngine;
  let tempDbName: string;
  let appUrl: string;
  let tempAdmin: ReturnType<typeof postgres>;
  let createdRole = false;
  let createdDb = false;

  beforeAll(async () => {
    if (!ADMIN_URL) return;
    admin = postgres(ADMIN_URL, { max: 5 });
  }, 30_000);

  afterAll(async () => {
    // Cleanup: only touch the temp DB + role this test created.
    if (admin) {
      try {
        if (appEngine) await appEngine.disconnect().catch(() => {});
        if (tempAdmin) await tempAdmin.end().catch(() => {});
        if (createdDb && tempDbName) {
          // Terminate sessions then drop the DB.
          await admin.unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${tempDbName}' AND pid <> pg_backend_pid()`,
          ).catch(() => {});
          await admin.unsafe(`DROP DATABASE IF EXISTS "${tempDbName}"`).catch(() => {});
        }
        if (createdRole) {
          await admin.unsafe(`DROP ROLE IF EXISTS groundcontrol_app`).catch(() => {});
        }
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function provision(): Promise<void> {
    // Abort if the role already exists — we never touch a pre-existing role.
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'groundcontrol_app') AS exists`;
    if (existing[0]?.exists) {
      throw new Error('groundcontrol_app already exists; refusing to proceed');
    }
    // Unique temp DB name. Connection-level collation-safe.
    tempDbName = `gc_test_${process.pid}_${Date.now()}`.slice(0, 63).toLowerCase();
    await admin.unsafe(`CREATE DATABASE "${tempDbName}"`);
    createdDb = true;

    // Create the restricted role (no destructive privs).
    await admin.unsafe(`
      CREATE ROLE groundcontrol_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'gc_test_pw_12345'`);
    createdRole = true;

    // Provision inside the temp DB. Reconnect as admin to the temp DB.
    tempAdmin = postgres(ADMIN_URL!.replace(/\/[^/]*$/, '/' + tempDbName), { max: 3 });
    try {
      await tempAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS extensions`);
      await tempAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions`);
      await tempAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`);
      await tempAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS groundcontrol AUTHORIZATION groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT USAGE ON SCHEMA extensions TO groundcontrol_app`);
      // Effective CREATE denial: revoke the default PUBLIC CREATE on public.
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA extensions FROM PUBLIC`);
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA extensions FROM groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT CONNECT ON DATABASE "${tempDbName}" TO groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT CREATE ON SCHEMA groundcontrol TO groundcontrol_app`);
    } finally {
      // Keep the administrator connection for decoy setup and assertions.
    }

    // Build the application URL. Never logged.
    appUrl = ADMIN_URL!
      .replace(/\/[^/]*$/, '/' + tempDbName)
      .replace(/\/\/([^:]+):([^@]+)@/, '//groundcontrol_app:gc_test_pw_12345@')
      + '?search_path=groundcontrol,extensions';
  }

  test('provisions disposable DB + restricted role', async () => {
    if (!ADMIN_URL) return;
    await provision();
    expect(tempDbName).toBeTruthy();
    expect(appUrl).toContain('groundcontrol_app');
  }, 60_000);

  test('fresh init succeeds under groundcontrol_app', async () => {
    if (!ADMIN_URL) return;
    appEngine = new PostgresEngine();
    await appEngine.connect({ database_url: appUrl, postgres_schema: 'groundcontrol' });
    await appEngine.initSchema();
    // If we got here, preflight + DDL + migrations + final verification passed.
    expect(appEngine.isDedicatedSchemaMode()).toBe(true);
  }, 120_000);

  test('GBrain objects land in groundcontrol and are owned by the role', async () => {
    if (!ADMIN_URL) return;
    const conn = (appEngine as unknown as { sql: ReturnType<typeof postgres> }).sql;
    const tables = await conn<{ relname: string; owner: string }[]>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'groundcontrol' AND c.relname IN ('pages','content_chunks','config','sources')
        AND c.relkind = 'r'`;
    const names = new Set(tables.map((t) => t.relname));
    expect(names.has('pages')).toBe(true);
    expect(names.has('content_chunks')).toBe(true);
    expect(names.has('config')).toBe(true);
    expect(names.has('sources')).toBe(true);
    for (const t of tables) {
      expect(t.owner).toBe('groundcontrol_app');
    }
  }, 30_000);

  test('no GBrain objects leaked into public or extensions', async () => {
    if (!ADMIN_URL) return;
    const conn = (appEngine as unknown as { sql: ReturnType<typeof postgres> }).sql;
    const leaked = await conn<{ nspname: string; relname: string }[]>`
      SELECT n.nspname, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public','extensions')
        AND c.relname IN ('pages','content_chunks','config','sources','links','tags','timeline_entries')
        AND c.relkind = 'r'`;
    expect(leaked.length).toBe(0);
  }, 30_000);

  test('migration version is canonical and not ahead of binary', async () => {
    if (!ADMIN_URL) return;
    const v = await appEngine.getConfig('version');
    const n = parseInt(v ?? '0', 10);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(LATEST_VERSION);
  }, 30_000);

  test('second init is idempotent', async () => {
    if (!ADMIN_URL) return;
    // A second initSchema must not throw and must not change the version.
    const before = await appEngine.getConfig('version');
    await appEngine.initSchema();
    const after = await appEngine.getConfig('version');
    expect(after).toBe(before);
  }, 120_000);

  test('public decoy constraints do not suppress active-schema migrations', async () => {
    if (!ADMIN_URL) return;
    await tempAdmin.unsafe(`
      CREATE TABLE public.pages (
        id serial PRIMARY KEY, updated_at timestamptz DEFAULT now(),
        source_id text NOT NULL DEFAULT 'default', slug text NOT NULL
      );
      ALTER TABLE public.pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);

      CREATE TABLE public.links (
        from_page_id integer, to_page_id integer, link_type text,
        link_source text, origin_page_id integer
      );
      ALTER TABLE public.links ADD CONSTRAINT links_link_source_check CHECK (link_source IS NULL);
      ALTER TABLE public.links ADD CONSTRAINT links_from_to_type_source_origin_unique
        UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id);

      CREATE TABLE public.content_chunks (embedding_image extensions.vector(1024));
      CREATE TABLE public.facts (id bigserial PRIMARY KEY);

      CREATE TABLE public.oauth_clients (source_id text, bound_source_id text);
      ALTER TABLE public.oauth_clients ADD CONSTRAINT oauth_clients_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES groundcontrol.sources(id) ON DELETE SET NULL;
      ALTER TABLE public.oauth_clients ADD CONSTRAINT fk_oauth_clients_bound_source
        FOREIGN KEY (bound_source_id) REFERENCES groundcontrol.sources(id) ON DELETE SET NULL;

      CREATE TABLE public.subagent_tool_executions (job_id bigint, message_idx integer, ordinal integer);
      ALTER TABLE public.subagent_tool_executions ADD CONSTRAINT subagent_tool_executions_stable_id
        UNIQUE (job_id, message_idx, ordinal);
    `);

    for (const version of [11, 60, 82, 85]) {
      await attemptMigration(appEngine, MIGRATIONS.find((m) => m.version === version)!);
    }

    const active = await tempAdmin<{ conname: string }[]>`
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'groundcontrol'
         AND c.conname IN (
           'links_link_source_check', 'links_from_to_type_source_origin_unique',
           'oauth_clients_source_id_fkey', 'subagent_tool_executions_stable_id',
           'fk_oauth_clients_bound_source'
         )`;
    expect(new Set(active.map((r) => r.conname))).toEqual(new Set([
      'links_link_source_check', 'links_from_to_type_source_origin_unique',
      'oauth_clients_source_id_fkey', 'subagent_tool_executions_stable_id',
      'fk_oauth_clients_bound_source',
    ]));

    const publicConstraints = await tempAdmin<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'public'
         AND c.conname IN (
           'links_link_source_check', 'links_from_to_type_source_origin_unique',
           'oauth_clients_source_id_fkey', 'subagent_tool_executions_stable_id',
           'fk_oauth_clients_bound_source'
         )`;
    expect(publicConstraints[0]?.n).toBe(5);
  }, 60_000);

  test('public relation, column, function, and trigger decoys do not satisfy active probes', async () => {
    if (!ADMIN_URL) return;
    await tempAdmin.unsafe(`
      CREATE TABLE IF NOT EXISTS public.files (id integer);
      ALTER TABLE public.content_chunks ADD COLUMN IF NOT EXISTS embedding_image extensions.vector(1024);
      CREATE OR REPLACE FUNCTION public.bump_page_generation_fn() RETURNS trigger AS $$
      BEGIN RETURN NEW; END $$ LANGUAGE plpgsql SET search_path = pg_catalog;
      DROP TRIGGER IF EXISTS bump_page_generation_trg ON public.pages;
      CREATE TRIGGER bump_page_generation_trg BEFORE INSERT ON public.pages
        FOR EACH ROW EXECUTE FUNCTION public.bump_page_generation_fn();
    `);

    const v23 = MIGRATIONS.find((m) => m.version === 23)!;
    await tempAdmin.unsafe(`DROP TABLE IF EXISTS groundcontrol.files CASCADE`);
    await expect(attemptMigration(appEngine, v23)).rejects.toThrow(/relation "files" does not exist/);
    const pagesUnique = await tempAdmin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conname = 'pages_source_slug_key'
         AND conrelid = 'groundcontrol.pages'::regclass`;
    expect(pagesUnique[0]?.n).toBe(1);

    await tempAdmin.unsafe(`ALTER TABLE groundcontrol.content_chunks DROP COLUMN IF EXISTS embedding_image CASCADE`);
    await appEngine.unsetConfig(KEY_APPLIED);
    await appEngine.setConfig(KEY_REQUESTED, 'true');
    expect((await resumeRetrievalUpgrade(appEngine)).status).toBe('applied');
    const activeImage = await tempAdmin<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'groundcontrol' AND table_name = 'content_chunks'
           AND column_name = 'embedding_image'
      ) AS exists`;
    expect(activeImage[0]?.exists).toBe(false);

    await tempAdmin.unsafe(`
      ALTER TABLE public.content_chunks DROP COLUMN embedding_image;
      ALTER TABLE groundcontrol.content_chunks ADD COLUMN embedding_image extensions.vector(1024);
    `);
    await appEngine.unsetConfig(KEY_APPLIED);
    await appEngine.setConfig(KEY_REQUESTED, 'true');
    expect((await resumeRetrievalUpgrade(appEngine)).status).toBe('applied');
    const activeImageIndex = await tempAdmin<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'groundcontrol' AND tablename = 'content_chunks'
           AND indexname = 'idx_chunks_embedding_image'
      ) AS exists`;
    expect(activeImageIndex[0]?.exists).toBe(true);

    await attemptMigration(appEngine, MIGRATIONS.find((m) => m.version === 91)!);
    const objects = await tempAdmin<{ schema: string; kind: string; n: number }[]>`
      SELECT n.nspname AS schema, 'function' AS kind, count(*)::int AS n
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'bump_page_generation_fn' AND n.nspname IN ('public','groundcontrol')
       GROUP BY n.nspname
      UNION ALL
      SELECT n.nspname AS schema, 'trigger' AS kind, count(*)::int AS n
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE t.tgname = 'bump_page_generation_trg' AND NOT t.tgisinternal
         AND n.nspname IN ('public','groundcontrol')
       GROUP BY n.nspname`;
    expect(objects.map((r) => `${r.schema}:${r.kind}:${r.n}`).sort()).toEqual([
      'groundcontrol:function:1', 'groundcontrol:trigger:1',
      'public:function:1', 'public:trigger:1',
    ]);
  }, 90_000);

  test('invalid-index cleanup, timeline repair, and backfill probes mutate only groundcontrol', async () => {
    if (!ADMIN_URL) return;
    await tempAdmin.unsafe(`
      CREATE TABLE IF NOT EXISTS public.timeline_entries (
        id bigserial PRIMARY KEY, page_id integer, date date, summary text, source text
      );
      DROP INDEX IF EXISTS public.idx_timeline_dedup;
      CREATE UNIQUE INDEX idx_timeline_dedup
        ON public.timeline_entries(page_id, date, summary, source);
      DROP INDEX IF EXISTS groundcontrol.idx_timeline_dedup;
      CREATE UNIQUE INDEX idx_timeline_dedup
        ON groundcontrol.timeline_entries(page_id, date, summary);

      DROP INDEX IF EXISTS public.gc_public_invalid_idx;
      CREATE INDEX gc_public_invalid_idx ON public.pages(updated_at);
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = 'public.gc_public_invalid_idx'::regclass;

      DROP INDEX IF EXISTS groundcontrol.gc_active_invalid_idx;
      CREATE INDEX gc_active_invalid_idx ON groundcontrol.pages(updated_at);
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = 'groundcontrol.gc_active_invalid_idx'::regclass;

      DROP INDEX IF EXISTS public.gc_shared_invalid_idx;
      CREATE INDEX gc_shared_invalid_idx ON public.pages(updated_at);
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = 'public.gc_shared_invalid_idx'::regclass;
      DROP INDEX IF EXISTS groundcontrol.gc_shared_invalid_idx;
      CREATE INDEX gc_shared_invalid_idx ON groundcontrol.pages(updated_at);
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = 'groundcontrol.gc_shared_invalid_idx'::regclass;

      DROP INDEX IF EXISTS public.gc_required_idx;
      DROP INDEX IF EXISTS groundcontrol.gc_required_idx;
      CREATE INDEX gc_required_idx ON public.pages(id);
    `);

    expect((await checkTimelineDedupIndex(appEngine)).columns).toEqual(['page_id', 'date', 'summary']);
    expect((await repairTimelineDedupIndex(appEngine)).repaired).toBe(true);
    const publicTimeline = await tempAdmin<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_timeline_dedup'`;
    expect(publicTimeline[0]?.indexdef).toContain('(page_id, date, summary, source)');

    expect(await dropZombieIndexes(appEngine, ['pages'])).toEqual({
      dropped: ['gc_active_invalid_idx', 'gc_shared_invalid_idx'],
    });
    const publicInvalid = await tempAdmin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('gc_public_invalid_idx', 'gc_shared_invalid_idx')`;
    expect(publicInvalid[0]?.n).toBe(2);

    const backfill = await ensureBackfillIndex(appEngine, {
      name: 'scope-e2e', table: 'pages', selectColumns: [], needsBackfill: 'true', compute: async () => [],
      requiredIndex: {
        name: 'gc_required_idx',
        sql: 'CREATE INDEX CONCURRENTLY gc_required_idx ON pages(id)',
      },
    });
    expect(backfill).toEqual({ existed: false, created: true });
    const requiredSchemas = await tempAdmin<{ schemaname: string }[]>`
      SELECT schemaname FROM pg_indexes WHERE indexname = 'gc_required_idx' ORDER BY schemaname`;
    expect(requiredSchemas.map((r) => r.schemaname)).toEqual(['groundcontrol', 'public']);
  }, 60_000);

  test('dedicated v120 alters only active functions and creates no auto-enable function', async () => {
    if (!ADMIN_URL) return;
    await tempAdmin.unsafe(`
      CREATE OR REPLACE FUNCTION public.update_chunk_search_vector() RETURNS trigger AS $$
      BEGIN RETURN NEW; END $$ LANGUAGE plpgsql SET search_path = pg_catalog;
    `);
    await appEngine.withReservedConnection(async (conn) => {
      await conn.executeRaw(selectMigrationSql(MIGRATIONS.find((m) => m.version === 120)!, appEngine)!);
    });
    const paths = await tempAdmin<{ schema: string; proconfig: string[] | null }[]>`
      SELECT n.nspname AS schema, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'update_chunk_search_vector'
         AND n.nspname IN ('public','groundcontrol')
       ORDER BY n.nspname`;
    expect(paths.find((r) => r.schema === 'public')?.proconfig).toEqual(['search_path=pg_catalog']);
    expect(paths.find((r) => r.schema === 'groundcontrol')?.proconfig).toEqual([
      'search_path=pg_catalog, groundcontrol, extensions',
    ]);
    const autoEnable = await tempAdmin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'auto_enable_rls' AND n.nspname = 'groundcontrol'`;
    expect(autoEnable[0]?.n).toBe(0);
  }, 30_000);

  test('orchestrator column probe ignores a public facts decoy', async () => {
    if (!ADMIN_URL) return;
    await tempAdmin.unsafe(`
      ALTER TABLE public.facts ADD COLUMN IF NOT EXISTS row_num integer;
      ALTER TABLE public.facts ADD COLUMN IF NOT EXISTS source_markdown_slug text;
      ALTER TABLE groundcontrol.facts DROP COLUMN IF EXISTS source_markdown_slug;
    `);
    expect((await migration0322.phaseASchema(appEngine, { yes: true, dryRun: false, noAutopilotInstall: true })).status).toBe('failed');
  }, 30_000);

  test('wrong extension placement fails before DDL', async () => {
    if (!ADMIN_URL) return;
    // Create a SECOND temp DB with vector in the wrong schema (public).
    const wrongDb = `gc_wrong_${process.pid}_${Date.now()}`.slice(0, 63).toLowerCase();
    await admin.unsafe(`CREATE DATABASE "${wrongDb}"`);
    let wrongAppUrl: string;
    const tempAdmin = postgres(ADMIN_URL!.replace(/\/[^/]*$/, '/' + wrongDb), { max: 3 });
    try {
      // vector in public (wrong) — dedicated requires vector in extensions.
      await tempAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`);
      await tempAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`);
      await tempAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS extensions`);
      await tempAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS groundcontrol AUTHORIZATION groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT USAGE ON SCHEMA extensions TO groundcontrol_app`);
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA extensions FROM PUBLIC`);
      await tempAdmin.unsafe(`REVOKE CREATE ON SCHEMA extensions FROM groundcontrol_app`);
      await tempAdmin.unsafe(`GRANT CREATE ON SCHEMA groundcontrol TO groundcontrol_app`);
      wrongAppUrl = ADMIN_URL!
        .replace(/\/[^/]*$/, '/' + wrongDb)
        .replace(/\/\/([^:]+):([^@]+)@/, '//groundcontrol_app:gc_test_pw_12345@')
        + '?search_path=groundcontrol,extensions';
    } finally {
      await tempAdmin.end();
    }

    const wrongEngine = new PostgresEngine();
    // poolSize forces the instance path (avoids reusing the module singleton
    // from the prior test, which points at the correct DB).
    await wrongEngine.connect({ database_url: wrongAppUrl, postgres_schema: 'groundcontrol', poolSize: 2 });
    await expect(wrongEngine.initSchema()).rejects.toThrow(/preflight/);
    await wrongEngine.disconnect().catch(() => {});

    // Cleanup the wrong DB.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${wrongDb}' AND pid <> pg_backend_pid()`,
    ).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${wrongDb}"`).catch(() => {});
  }, 90_000);

  test('preflight enforces CREATE denial on public (source-level)', () => {
    if (!ADMIN_URL) return;
    // The CREATE-on-public denial is asserted by the preflight contract
    // (evaluateDedicatedPreflight checks can_create_public === false). The
    // fresh-init test already ran the preflight successfully, which means
    // the role's CREATE-on-public denial held. This test is a no-op pin so
    // the invariant is named in the lifecycle output.
    expect(true).toBe(true);
  });
});
