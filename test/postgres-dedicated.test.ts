/**
 * Dedicated groundcontrol schema mode — config + URL normalization unit tests.
 *
 * Pins the fixed-mode predicate, env/file precedence, and the pure URL
 * normalizer. The normalizer must:
 *  - insert the authoritative search path when absent;
 *  - accept the exact canonical path;
 *  - canonicalize whitespace-equivalent forms;
 *  - reject reordered/extra/public members and conflicting direct URLs;
 *  - never expose userinfo or password in thrown errors;
 *  - leave non-dedicated inputs byte-for-byte unchanged.
 *
 * Pattern follows test/direct-database-url.test.ts (temp GBRAIN_HOME +
 * writeConfig helper).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEDICATED_SEARCH_PATH,
  isDedicatedSchemaMode,
  normalizeDedicatedPostgresConfig,
  evaluateDedicatedPreflight,
  type DedicatedPreflightRow,
} from '../src/core/postgres-dedicated.ts';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const POOLER_URL =
  'postgresql://postgres.someref:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('postgres_schema config precedence + validation', () => {
  async function withConfig<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-dedicated-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    try {
      return await withEnv({
        GBRAIN_HOME: home,
        GBRAIN_POSTGRES_SCHEMA: undefined,
        GBRAIN_DATABASE_URL: undefined,
        GBRAIN_DIRECT_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
      }, () => fn(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  function writeConfig(home: string, obj: Record<string, unknown>): void {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(obj));
  }

  test('file-plane postgres_schema surfaces in loadConfig', async () => {
    await withConfig((home) => {
      writeConfig(home, { engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
      expect(loadConfig()?.postgres_schema).toBe('groundcontrol');
    });
  });

  test('GBRAIN_POSTGRES_SCHEMA overrides file value', async () => {
    await withConfig(async (home) => {
      writeConfig(home, { engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
      await withEnv({ GBRAIN_POSTGRES_SCHEMA: 'groundcontrol' }, () => {
        expect(loadConfig()?.postgres_schema).toBe('groundcontrol');
      });
    });
  });

  test('toEngineConfig preserves postgres_schema', async () => {
    await withConfig((home) => {
      writeConfig(home, { engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
      expect(toEngineConfig(loadConfig()!).postgres_schema).toBe('groundcontrol');
    });
  });

  test('absent field leaves legacy config byte-compatible', async () => {
    await withConfig((home) => {
      writeConfig(home, { engine: 'postgres', database_url: POOLER_URL });
      const cfg = loadConfig()!;
      expect(cfg.postgres_schema).toBeUndefined();
      expect(toEngineConfig(cfg).postgres_schema).toBeUndefined();
    });
  });

  test('invalid postgres_schema values are rejected by loadConfig', async () => {
    await withConfig((home) => {
      const invalid = ['public', '', ' groundcontrol ', 'gbrain', 'GROUNDCONTROL', 'groundcontrol ', 'x'];
      for (const v of invalid) {
        writeConfig(home, { engine: 'postgres', database_url: POOLER_URL, postgres_schema: v });
        expect(() => loadConfig(), `expected throw for postgres_schema=${JSON.stringify(v)}`).toThrow();
      }
    });
  });
});

describe('isDedicatedSchemaMode predicate', () => {
  test('false when field absent', () => {
    expect(isDedicatedSchemaMode({})).toBe(false);
    expect(isDedicatedSchemaMode({ postgres_schema: undefined })).toBe(false);
  });
  test('true only for exact groundcontrol', () => {
    expect(isDedicatedSchemaMode({ postgres_schema: 'groundcontrol' })).toBe(true);
    expect(isDedicatedSchemaMode({ postgres_schema: 'public' })).toBe(false);
    expect(isDedicatedSchemaMode({ postgres_schema: 'gbrain' })).toBe(false);
  });
});

describe('DEDICATED_SEARCH_PATH constant', () => {
  test('equals the canonical path', () => {
    expect(DEDICATED_SEARCH_PATH).toBe('groundcontrol,extensions');
  });
});

describe('normalizeDedicatedPostgresConfig — URL normalization', () => {
  test('absent field returns inputs unchanged', () => {
    const url = 'postgresql://u:p@h:5432/db?search_path=anything';
    const out = normalizeDedicatedPostgresConfig({ database_url: url });
    expect(out.database_url).toBe(url);
  });

  test('absent search_path is inserted', () => {
    const out = normalizeDedicatedPostgresConfig({
      database_url: 'postgresql://u:p@h:5432/db',
      postgres_schema: 'groundcontrol',
    });
    expect(out.database_url).toContain('search_path=groundcontrol,extensions');
  });

  test('exact canonical match is accepted', () => {
    const url = 'postgresql://u:p@h:5432/db?search_path=groundcontrol,extensions';
    const out = normalizeDedicatedPostgresConfig({ database_url: url, postgres_schema: 'groundcontrol' });
    expect(out.database_url).toBe(url);
  });

  test('whitespace-equivalent match is canonicalized', () => {
    const out = normalizeDedicatedPostgresConfig({
      database_url: 'postgresql://u:p@h:5432/db?search_path=groundcontrol%2C+extensions',
      postgres_schema: 'groundcontrol',
    });
    expect(out.database_url).toContain('search_path=groundcontrol,extensions');
  });

  test('reordered or extra members reject', () => {
    expect(() =>
      normalizeDedicatedPostgresConfig({
        database_url: 'postgresql://u:p@h:5432/db?search_path=extensions,groundcontrol',
        postgres_schema: 'groundcontrol',
      }),
    ).toThrow();
  });

  test('public in path rejects', () => {
    expect(() =>
      normalizeDedicatedPostgresConfig({
        database_url: 'postgresql://u:p@h:5432/db?search_path=groundcontrol,public',
        postgres_schema: 'groundcontrol',
      }),
    ).toThrow();
  });

  test('three-member path rejects', () => {
    expect(() =>
      normalizeDedicatedPostgresConfig({
        database_url: 'postgresql://u:p@h:5432/db?search_path=groundcontrol,extensions,public',
        postgres_schema: 'groundcontrol',
      }),
    ).toThrow();
  });

  test('conflicting direct URL rejects', () => {
    expect(() =>
      normalizeDedicatedPostgresConfig({
        database_url: 'postgresql://u:p@h:6543/db',
        direct_database_url: 'postgresql://u:p@h:5432/db?search_path=gbrain',
        postgres_schema: 'groundcontrol',
      }),
    ).toThrow();
  });

  test('direct URL is also normalized when canonical', () => {
    const out = normalizeDedicatedPostgresConfig({
      database_url: 'postgresql://u:p@h:6543/db',
      direct_database_url: 'postgresql://u:p@h:5432/db',
      postgres_schema: 'groundcontrol',
    });
    expect(out.direct_database_url).toContain('search_path=groundcontrol,extensions');
  });

  test('postgres:// scheme round-trips', () => {
    const out = normalizeDedicatedPostgresConfig({
      database_url: 'postgres://u:p@h:5432/db',
      postgres_schema: 'groundcontrol',
    });
    expect(out.database_url!.startsWith('postgres://')).toBe(true);
    expect(out.database_url).toContain('search_path=groundcontrol,extensions');
  });

  test('errors never expose userinfo or password', () => {
    try {
      normalizeDedicatedPostgresConfig({
        database_url: 'postgresql://secretuser:secretpw@h:5432/db?search_path=bad',
        postgres_schema: 'groundcontrol',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).not.toContain('secretuser');
      expect(String(e)).not.toContain('secretpw');
    }
  });

  test('other query params are preserved', () => {
    const out = normalizeDedicatedPostgresConfig({
      database_url: 'postgresql://u:p@h:5432/db?sslmode=require',
      postgres_schema: 'groundcontrol',
    });
    expect(out.database_url).toContain('sslmode=require');
    expect(out.database_url).toContain('search_path=groundcontrol,extensions');
  });
});

/** Build a row that satisfies every preflight invariant. */
function goodRow(overrides: Partial<DedicatedPreflightRow> = {}): DedicatedPreflightRow {
  return {
    current_user: 'groundcontrol_app',
    current_schema: 'groundcontrol',
    pg_version: 16,
    schema_owner: 'groundcontrol_app',
    has_connect: true,
    has_usage_public: true,
    has_usage_extensions: true,
    can_create_public: false,
    can_create_extensions: false,
    has_create_groundcontrol: true,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    ...overrides,
  };
}

const GOOD_EXTENSIONS = [
  { extname: 'vector', schema: 'extensions' },
  { extname: 'pg_trgm', schema: 'public' },
];

describe('evaluateDedicatedPreflight — contract checks', () => {
  test('happy path returns null', () => {
    expect(evaluateDedicatedPreflight(goodRow(), GOOD_EXTENSIONS)).toBeNull();
  });

  test('rejects wrong current_user', () => {
    expect(evaluateDedicatedPreflight(goodRow({ current_user: 'postgres' }), GOOD_EXTENSIONS)).toMatch(/current_user/);
  });

  test('rejects wrong current_schema', () => {
    expect(evaluateDedicatedPreflight(goodRow({ current_schema: 'public' }), GOOD_EXTENSIONS)).toMatch(/current_schema/);
  });

  test('rejects schema not owned by role', () => {
    expect(evaluateDedicatedPreflight(goodRow({ schema_owner: 'postgres' }), GOOD_EXTENSIONS)).toMatch(/owned/);
  });

  test('rejects PostgreSQL below 13', () => {
    expect(evaluateDedicatedPreflight(goodRow({ pg_version: 12 }), GOOD_EXTENSIONS)).toMatch(/PostgreSQL 13/);
  });

  test('rejects missing CONNECT', () => {
    expect(evaluateDedicatedPreflight(goodRow({ has_connect: false }), GOOD_EXTENSIONS)).toMatch(/CONNECT/);
  });

  test('rejects missing USAGE on public', () => {
    expect(evaluateDedicatedPreflight(goodRow({ has_usage_public: false }), GOOD_EXTENSIONS)).toMatch(/USAGE on public/);
  });

  test('rejects missing USAGE on extensions', () => {
    expect(evaluateDedicatedPreflight(goodRow({ has_usage_extensions: false }), GOOD_EXTENSIONS)).toMatch(/USAGE on extensions/);
  });

  test('rejects CREATE on public', () => {
    expect(evaluateDedicatedPreflight(goodRow({ can_create_public: true }), GOOD_EXTENSIONS)).toMatch(/CREATE on public/);
  });

  test('rejects CREATE on extensions', () => {
    expect(evaluateDedicatedPreflight(goodRow({ can_create_extensions: true }), GOOD_EXTENSIONS)).toMatch(/CREATE on extensions/);
  });

  test('rejects missing CREATE on groundcontrol', () => {
    expect(evaluateDedicatedPreflight(goodRow({ has_create_groundcontrol: false }), GOOD_EXTENSIONS)).toMatch(/CREATE on groundcontrol/);
  });

  test('rejects superuser', () => {
    expect(evaluateDedicatedPreflight(goodRow({ rolsuper: true }), GOOD_EXTENSIONS)).toMatch(/superuser/);
  });

  test('rejects BYPASSRLS', () => {
    expect(evaluateDedicatedPreflight(goodRow({ rolbypassrls: true }), GOOD_EXTENSIONS)).toMatch(/BYPASSRLS/);
  });

  test('rejects CREATEDB', () => {
    expect(evaluateDedicatedPreflight(goodRow({ rolcreatedb: true }), GOOD_EXTENSIONS)).toMatch(/CREATEDB/);
  });

  test('rejects CREATEROLE', () => {
    expect(evaluateDedicatedPreflight(goodRow({ rolcreaterole: true }), GOOD_EXTENSIONS)).toMatch(/CREATEROLE/);
  });

  test('rejects REPLICATION', () => {
    expect(evaluateDedicatedPreflight(goodRow({ rolreplication: true }), GOOD_EXTENSIONS)).toMatch(/REPLICATION/);
  });

  test('rejects vector missing', () => {
    expect(evaluateDedicatedPreflight(goodRow(), [{ extname: 'pg_trgm', schema: 'public' }])).toMatch(/vector/);
  });

  test('rejects vector in wrong schema', () => {
    expect(
      evaluateDedicatedPreflight(goodRow(), [
        { extname: 'vector', schema: 'public' },
        { extname: 'pg_trgm', schema: 'public' },
      ]),
    ).toMatch(/vector/);
  });

  test('rejects pg_trgm missing', () => {
    expect(evaluateDedicatedPreflight(goodRow(), [{ extname: 'vector', schema: 'extensions' }])).toMatch(/pg_trgm/);
  });

  test('rejects pg_trgm in wrong schema', () => {
    expect(
      evaluateDedicatedPreflight(goodRow(), [
        { extname: 'vector', schema: 'extensions' },
        { extname: 'pg_trgm', schema: 'extensions' },
      ]),
    ).toMatch(/pg_trgm/);
  });

  test('errors are redacted (no raw credential leak)', () => {
    // Even if a field somehow carried a URL, the redactor strips it.
    const msg = evaluateDedicatedPreflight(
      goodRow({ current_user: 'postgresql://user:pass@host:5432/db' }),
      GOOD_EXTENSIONS,
    );
    expect(msg).not.toContain('user:pass');
    expect(msg).not.toContain('host:5432');
  });
});
