/**
 * Task 7 (2026-07 dedicated schema wave) — init/migrate-engine persistence.
 *
 * Serial (not concurrent) because it reads source files + asserts structural
 * invariants that are sensitive to the exact wiring of postgres_schema across
 * the connect → initSchema → saveConfig sequence. The unit tests in
 * postgres-dedicated.test.ts cover the pure helpers; this file pins that the
 * command-layer call sites thread the field correctly.
 *
 * No real DB: these are source-level tripwires + the loadConfig/saveConfig
 * round-trip on a temp GBRAIN_HOME (the same pattern as
 * test/direct-database-url.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig, toEngineConfig, type GBrainConfig } from '../src/core/config.ts';

const POOLER_URL =
  'postgresql://postgres.someref:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('dedicated-config-persistence (serial) — init/migrate-engine wiring', () => {
  let home: string;
  const savedHome = process.env.GBRAIN_HOME;

  test('init.ts threads postgres_schema into engine.connect', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/init.ts'), 'utf8');
    expect(src).toMatch(/postgres_schema:\s*postgresSchema/);
  });

  test('init.ts persists postgres_schema in saveConfig', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/init.ts'), 'utf8');
    expect(src).toMatch(/postgres_schema:\s*postgresSchema as 'groundcontrol'/);
  });

  test('migrate-engine.ts threads postgres_schema into targetConfig', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/migrate-engine.ts'), 'utf8');
    expect(src).toMatch(/targetConfig\.postgres_schema\s*=/);
  });

  test('migrate-engine.ts runs verifyTarget before saveConfig in dedicated mode', () => {
    const src = readFileSync(join(import.meta.dir, '../src/commands/migrate-engine.ts'), 'utf8');
    // isDedicated gate appears before saveConfig.
    const dedicatedIdx = src.indexOf('isDedicated');
    const saveIdx = src.indexOf('saveConfig(newConfig)');
    expect(dedicatedIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    expect(dedicatedIdx).toBeLessThan(saveIdx);
  });

  test('postgres-engine has verifyDedicatedPostgres + wires it into initSchema', () => {
    const src = readFileSync(join(import.meta.dir, '../src/core/postgres-engine.ts'), 'utf8');
    expect(src).toMatch(/verifyDedicatedPostgres/);
    // Called inside initSchema after dropZombieIndexes.
    const zombieIdx = src.indexOf('dropZombieIndexes(this)');
    const verifyIdx = src.indexOf('this.verifyDedicatedPostgres(conn)');
    expect(zombieIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(zombieIdx);
  });

  test('loadConfig + saveConfig round-trips postgres_schema', () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-ded-persist-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    process.env.GBRAIN_HOME = home;
    try {
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'postgres', database_url: POOLER_URL, postgres_schema: 'groundcontrol' }),
      );
      const cfg = loadConfig()!;
      expect(cfg.postgres_schema).toBe('groundcontrol');
      // saveConfig preserves it.
      saveConfig({ ...cfg, embedding_model: 'zeroentropyai:zembed-1' });
      const cfg2 = loadConfig()!;
      expect(cfg2.postgres_schema).toBe('groundcontrol');
      expect(toEngineConfig(cfg2).postgres_schema).toBe('groundcontrol');
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
