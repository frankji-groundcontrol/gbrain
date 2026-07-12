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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEDICATED_SEARCH_PATH,
  isDedicatedSchemaMode,
  normalizeDedicatedPostgresConfig,
} from '../src/core/postgres-dedicated.ts';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const POOLER_URL =
  'postgresql://postgres.someref:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('postgres_schema config precedence + validation', () => {
  let home: string;
  const savedHome = process.env.GBRAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-dedicated-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    process.env.GBRAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(obj: Record<string, unknown>): void {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(obj));
  }

  test('file-plane postgres_schema surfaces in loadConfig', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
    expect(loadConfig()?.postgres_schema).toBe('groundcontrol');
  });

  test('GBRAIN_POSTGRES_SCHEMA overrides file value', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
    await withEnv({ GBRAIN_POSTGRES_SCHEMA: 'groundcontrol' }, () => {
      expect(loadConfig()?.postgres_schema).toBe('groundcontrol');
      return Promise.resolve();
    });
  });

  test('toEngineConfig preserves postgres_schema', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' });
    const cfg = loadConfig()!;
    expect(toEngineConfig(cfg).postgres_schema).toBe('groundcontrol');
  });

  test('absent field leaves legacy config byte-compatible', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    const cfg = loadConfig()!;
    expect(cfg.postgres_schema).toBeUndefined();
    expect(toEngineConfig(cfg).postgres_schema).toBeUndefined();
  });

  test('invalid postgres_schema values are rejected by loadConfig', () => {
    const invalid = ['public', '', ' groundcontrol ', 'gbrain', 'GROUNDCONTROL', 'groundcontrol ', 'x'];
    for (const v of invalid) {
      writeConfig({ engine: 'postgres', database_url: POOLER_URL, postgres_schema: v });
      expect(() => loadConfig(), `expected throw for postgres_schema=${JSON.stringify(v)}`).toThrow();
    }
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
