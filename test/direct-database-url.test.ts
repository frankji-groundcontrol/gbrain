/**
 * File-plane `direct_database_url` (2026-07, China-network wave).
 *
 * Supabase's derived direct host (db.<ref>.supabase.co:5432) is IPv6-only
 * and black-holes on some networks (observed: IPv4-preferring paths in
 * mainland China — TCP opens, the Postgres handshake never completes, and
 * initSchema hangs forever). GBRAIN_DIRECT_DATABASE_URL already existed as
 * an env-only escape hatch, but env vars don't reach daemon-spawned gbrain
 * processes (MCP serve, launchd, cron). These tests pin the file-plane slot:
 * config.json `direct_database_url` → loadConfig merge (env wins) →
 * toEngineConfig → ConnectionManager opts.directUrl.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConnectionManager, deriveDirectUrl } from '../src/core/connection-manager.ts';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';

const POOLER_URL =
  'postgresql://postgres.someref:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
const SESSION_URL =
  'postgresql://postgres.someref:pw@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres?search_path=gbrain';

describe('ConnectionManager directUrl precedence', () => {
  const savedEnv = process.env.GBRAIN_DIRECT_DATABASE_URL;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    else process.env.GBRAIN_DIRECT_DATABASE_URL = savedEnv;
  });

  test('opts.directUrl (config-resolved) beats env and derive', () => {
    process.env.GBRAIN_DIRECT_DATABASE_URL = 'postgresql://env-wins@example.com:5432/x';
    const cm = new ConnectionManager({ url: POOLER_URL, directUrl: SESSION_URL });
    expect(cm.resolveDirectUrl()).toBe(SESSION_URL);
  });

  test('env override still works when no opts.directUrl given', () => {
    process.env.GBRAIN_DIRECT_DATABASE_URL = SESSION_URL;
    const cm = new ConnectionManager({ url: POOLER_URL });
    expect(cm.resolveDirectUrl()).toBe(SESSION_URL);
  });

  test('dedicated mode rejects a conflicting env direct URL before pool construction', () => {
    process.env.GBRAIN_DIRECT_DATABASE_URL =
      'postgresql://u:p@h:5432/db?search_path=public';
    expect(() => new ConnectionManager({
      url: POOLER_URL,
      postgresSchema: 'groundcontrol',
    })).toThrow('search_path must be exactly "groundcontrol,extensions"');
  });

  test('falls back to derived direct URL when neither opts nor env set', () => {
    delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    const cm = new ConnectionManager({ url: POOLER_URL });
    expect(cm.resolveDirectUrl()).toBe(deriveDirectUrl(POOLER_URL));
    expect(cm.resolveDirectUrl()).toContain('db.someref.supabase.co');
  });
});

describe('loadConfig direct_database_url plumbing', () => {
  let home: string;
  const saved = {
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    GBRAIN_DIRECT_DATABASE_URL: process.env.GBRAIN_DIRECT_DATABASE_URL,
    GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-direct-url-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    process.env.GBRAIN_HOME = home;
    delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(obj: Record<string, unknown>): void {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(obj));
  }

  test('file-plane direct_database_url surfaces in loadConfig result', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, direct_database_url: SESSION_URL });
    const cfg = loadConfig();
    expect(cfg?.direct_database_url).toBe(SESSION_URL);
  });

  test('env GBRAIN_DIRECT_DATABASE_URL wins over the file value', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, direct_database_url: SESSION_URL });
    process.env.GBRAIN_DIRECT_DATABASE_URL = 'postgresql://env@example.com:5432/x';
    const cfg = loadConfig();
    expect(cfg?.direct_database_url).toBe('postgresql://env@example.com:5432/x');
  });

  test('toEngineConfig threads direct_database_url through to the engine', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL, direct_database_url: SESSION_URL });
    const cfg = loadConfig()!;
    expect(toEngineConfig(cfg).direct_database_url).toBe(SESSION_URL);
  });

  test('absent everywhere stays undefined (derive path untouched)', () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    const cfg = loadConfig()!;
    expect(cfg.direct_database_url).toBeUndefined();
    expect(toEngineConfig(cfg).direct_database_url).toBeUndefined();
  });
});

describe('bare-URL connect sites thread the direct override (static tripwire)', () => {
  // init and migrate-engine construct EngineConfig from a raw URL (no
  // loadConfig/toEngineConfig), so they must thread direct_database_url by
  // hand. A refactor that drops it re-introduces the IPv6 init hang.
  test('init.ts passes direct_database_url at its engine.connect call', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/init.ts'), 'utf8');
    expect(src).toMatch(/database_url:\s*databaseUrl[\s\S]{0,600}direct_database_url:/);
  });

  test('migrate-engine.ts sets direct_database_url on targetConfig', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/migrate-engine.ts'), 'utf8');
    expect(src).toMatch(/targetConfig\.direct_database_url\s*=/);
  });
});

describe('host/worker/reflex reuse the complete resolved EngineConfig (static tripwire)', () => {
  // 2026-07 dedicated-schema wave: every connect site must spread the full
  // toEngineConfig(config) (or a resolved EngineConfig) so postgres_schema +
  // direct_database_url propagate. Reconstructing { database_url } by hand
  // drops the field and silently falls back to legacy behavior.
  test('brain-registry host uses toEngineConfig', () => {
    const src = readFileSync(join(import.meta.dir, '../src/core/brain-registry.ts'), 'utf8');
    expect(src).toMatch(/toEngineConfig\(config\)/);
    expect(src).not.toMatch(/database_url:\s*config\.database_url/);
  });

  test('reflex uses toEngineConfig', () => {
    const src = readFileSync(join(import.meta.dir, '../src/core/context/reflex.ts'), 'utf8');
    expect(src).toMatch(/toEngineConfig\(cfg/);
    expect(src).not.toMatch(/database_url:\s*cfg\?\.database_url/);
  });

  test('import worker spreads full engine config', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/import.ts'), 'utf8');
    expect(src).toMatch(/toEngineConfig\(config\)/);
    expect(src).toMatch(/\.\.\.baseEngineConfig,\s*poolSize/);
    // No hand-built { database_url } connect calls remain.
    expect(src).not.toMatch(/connect\(\s*\{\s*database_url:\s*databaseUrl/);
  });

  test('sync worker spreads full engine config', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/sync.ts'), 'utf8');
    expect(src).toMatch(/toEngineConfig\(config\)/);
    expect(src).toMatch(/\.\.\.baseEngineConfig,\s*poolSize/);
    expect(src).not.toMatch(/connect\(\s*\{\s*database_url:\s*databaseUrl/);
  });
});
