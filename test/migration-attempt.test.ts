/**
 * Task 6 (2026-07 dedicated schema wave) — migration runner atomicity.
 *
 * Pins the complete-attempt semantics: schema work, verification, and version
 * advancement commit together for transactional migrations, and version
 * advances only after verification succeeds for non-transactional migrations.
 *
 * Uses a purpose-built fake engine (no real DB) so the full transactional
 * contract is unit-testable: the fake records every runMigration / setConfig
 * / executeRaw call and can be programmed to fail at any step.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine, ReservedConnection } from '../src/core/engine.ts';
import { attemptMigration, type Migration } from '../src/core/migrate.ts';

interface FakeEngineOpts {
  /** Fail the Nth runMigration call (1-indexed). */
  failRunMigrationOnAttempt?: number;
  /** Throw from executeRaw with this message (simulates reserved-conn failure). */
  failExecuteRaw?: string;
  /** Initial config row values. */
  config?: Record<string, string>;
}

function makeFakeEngine(opts: FakeEngineOpts = {}): BrainEngine & {
  setConfigCalls: { key: string; value: string }[];
  txRunMigrationCount: number;
  reservedLog: string[];
} {
  const config: Record<string, string> = { ...opts.config };
  const setConfigCalls: { key: string; value: string }[] = [];
  const reservedLog: string[] = [];
  let txRunMigrationCount = 0;

  const engine = {
    kind: 'postgres' as const,
    getConfig: async (key: string) => config[key] ?? null,
    setConfig: async (key: string, value: string) => {
      config[key] = value;
      setConfigCalls.push({ key, value });
    },
    transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
      const tx = {
        kind: 'postgres' as const,
        executeRaw: async <R>(sql: string): Promise<R[]> => {
          void sql;
          return [] as unknown as R[];
        },
        runMigration: async (version: number, sql: string) => {
          void version;
          void sql;
          txRunMigrationCount++;
          if (opts.failRunMigrationOnAttempt === txRunMigrationCount) {
            throw new Error(`simulated runMigration failure #${txRunMigrationCount}`);
          }
        },
        getConfig: async (key: string) => config[key] ?? null,
        setConfig: async (key: string, value: string) => {
          config[key] = value;
          setConfigCalls.push({ key, value });
        },
      };
      return fn(tx as unknown as BrainEngine);
    },
    withReservedConnection: async <T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> => {
      const conn: ReservedConnection = {
        executeRaw: async <R>(sql: string): Promise<R[]> => {
          reservedLog.push(sql);
          if (opts.failExecuteRaw) throw new Error(opts.failExecuteRaw);
          return [] as unknown as R[];
        },
      };
      return fn(conn);
    },
    executeRaw: async <R>(sql: string): Promise<R[]> => {
      void sql;
      if (opts.failExecuteRaw) throw new Error(opts.failExecuteRaw);
      return [] as unknown as R[];
    },
    setConfigCalls,
    txRunMigrationCount: 0,
    get txCount() { return txRunMigrationCount; },
    reservedLog,
  };
  // Make txRunMigrationCount readable after calls.
  Object.defineProperty(engine, 'txRunMigrationCount', { get: () => txRunMigrationCount });
  return engine as unknown as BrainEngine & typeof engine;
}

function makeMigration(overrides: Partial<Migration> = {}): Migration {
  return {
    version: 999,
    name: 'test_migration',
    sql: 'SELECT 1;',
    ...overrides,
  };
}

describe('attemptMigration — transactional atomicity (Task 6)', () => {
  test('verify failure prevents version advancement', async () => {
    const engine = makeFakeEngine({ config: { version: '1' } });
    const m = makeMigration({
      version: 2,
      sql: 'CREATE TABLE x ();',
      verify: async () => false,
      idempotent: false,
    });
    await expect(attemptMigration(engine, m)).rejects.toThrow();
    expect(engine.setConfigCalls.find((c) => c.key === 'version')).toBeUndefined();
  });

  test('verify success advances version', async () => {
    const engine = makeFakeEngine({ config: { version: '1' } });
    const m = makeMigration({
      version: 2,
      sql: 'CREATE TABLE x ();',
      verify: async () => true,
      idempotent: true,
    });
    await attemptMigration(engine, m);
    expect(engine.setConfigCalls.find((c) => c.key === 'version' && c.value === '2')).toBeDefined();
  });

  test('handler runs and version advances on success', async () => {
    const engine = makeFakeEngine({ config: { version: '1' } });
    let handlerRan = false;
    const m = makeMigration({
      version: 2,
      sql: 'CREATE TABLE x ();',
      handler: async () => { handlerRan = true; },
    });
    await attemptMigration(engine, m);
    expect(handlerRan).toBe(true);
    expect(engine.setConfigCalls.find((c) => c.key === 'version' && c.value === '2')).toBeDefined();
  });

  test('handler failure prevents version advancement (handler runs after txn commit)', async () => {
    // The handler runs AFTER the DDL transaction commits (historical handlers
    // use CREATE INDEX CONCURRENTLY which can't run inside a txn). A handler
    // failure does NOT roll back the DDL, but DOES prevent the version bump
    // so the migration is re-runnable (DDL is idempotent).
    const engine = makeFakeEngine({ config: { version: '1' } });
    const m = makeMigration({
      version: 2,
      sql: 'CREATE TABLE x ();',
      handler: async () => { throw new Error('handler boom'); },
    });
    await expect(attemptMigration(engine, m)).rejects.toThrow(/handler boom/);
    expect(engine.setConfigCalls.find((c) => c.key === 'version')).toBeUndefined();
  });

  test('SQL failure prevents version advancement', async () => {
    const engine = makeFakeEngine({ config: { version: '1' }, failRunMigrationOnAttempt: 2 });
    const m = makeMigration({
      version: 2,
      sql: 'CREATE TABLE x ();',
    });
    await expect(attemptMigration(engine, m)).rejects.toThrow(/simulated runMigration failure/);
    expect(engine.setConfigCalls.find((c) => c.key === 'version')).toBeUndefined();
  });

  test('non-transactional migration: version advances after SQL + verify', async () => {
    const engine = makeFakeEngine({ config: { version: '1' } });
    const m = makeMigration({
      version: 3,
      sql: 'CREATE INDEX CONCURRENTLY foo;',
      transaction: false,
      verify: async () => true,
    });
    await attemptMigration(engine, m);
    expect(engine.reservedLog.some((s) => s.includes('CREATE INDEX CONCURRENTLY'))).toBe(true);
    expect(engine.setConfigCalls.find((c) => c.key === 'version' && c.value === '3')).toBeDefined();
  });

  test('non-transactional migration: verify failure prevents version', async () => {
    const engine = makeFakeEngine({ config: { version: '1' } });
    const m = makeMigration({
      version: 3,
      sql: 'CREATE INDEX CONCURRENTLY foo;',
      transaction: false,
      verify: async () => false,
    });
    await expect(attemptMigration(engine, m)).rejects.toThrow();
    expect(engine.setConfigCalls.find((c) => c.key === 'version')).toBeUndefined();
  });

  test('source-level: transactional path runs verify inside engine.transaction', () => {
    const src = readFileSync(join(import.meta.dir, '../src/core/migrate.ts'), 'utf8');
    expect(src).toMatch(/export async function attemptMigration/);
    // Extract the attemptMigration function body.
    const fnMatch = src.match(/export async function attemptMigration[\s\S]*?\n}\n/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/engine\.transaction\(async \(tx\) =>/);
    // The transaction block contains the verify probe (read-only, safe in txn).
    const txnBlock = fnBody.match(/engine\.transaction\(async \(tx\) => \{[\s\S]*?\n    \}\);/);
    expect(txnBlock).not.toBeNull();
    expect(txnBlock![0]).toMatch(/m\.verify/);
    // The handler + setConfig run AFTER the transaction (handlers may use
    // CREATE INDEX CONCURRENTLY).
    const afterTxn = fnBody.slice(fnBody.indexOf('});') + 3);
    expect(afterTxn).toMatch(/m\.handler/);
    expect(afterTxn).toMatch(/setConfig\('version'/);
  });
});
