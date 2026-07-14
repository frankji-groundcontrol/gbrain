/**
 * hybridSearch meta-field accuracy (v0.25.0, callback-based API).
 *
 * v0.25.0 keeps hybridSearch's return as `Promise<SearchResult[]>` (so
 * Cathedral II callers stay unchanged) and surfaces meta via an optional
 * `onMeta` callback in HybridSearchOpts. Asserts the callback fires with
 * accurate values:
 *   - vector_enabled=false when OPENAI_API_KEY missing (keyword-only path)
 *   - detail_resolved reflects auto-detect + caller override
 *   - expansion_applied only true when expandFn returned variants
 *
 * Uses PGLite in-memory + no embedding calls (vector path doesn't need
 * real embeddings to test the meta flag since we control the env).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { PageInput, HybridSearchMeta } from '../src/core/types.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  // The test preload snapshots the developer's environment into the global
  // gateway. Configure this suite explicitly so keyless search stays
  // keyless even on a machine with real provider credentials.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page: PageInput = {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice Example is a test person for hybrid-meta tests.',
  };
  await engine.putPage('people/alice-example', page);
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

function withoutEmbeddingProvider<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({
    GBRAIN_HOME: emptyHome(),
    OPENAI_API_KEY: undefined,
    DASHSCOPE_API_KEY: undefined,
  }, fn);
}

async function runWithMeta(query: string, opts: Parameters<typeof hybridSearch>[2] = {}): Promise<HybridSearchMeta | null> {
  return withoutEmbeddingProvider(async () => {
    let captured: HybridSearchMeta | null = null;
    await hybridSearch(engine, query, { ...opts, onMeta: (m) => { captured = m; } });
    return captured;
  });
}

describe('hybridSearch return shape (v0.25.0 keeps SearchResult[])', () => {
  test.serial('returns SearchResult[] (unchanged from Cathedral II contract)', async () => {
    const out = await withoutEmbeddingProvider(() => hybridSearch(engine, 'alice'));
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('hybridSearch onMeta callback — vector_enabled', () => {
  test.serial('false when OPENAI_API_KEY is missing (keyword-only path)', async () => {
    const meta = await runWithMeta('alice');
    expect(meta).not.toBeNull();
    expect(meta!.vector_enabled).toBe(false);
  });
});

describe('hybridSearch onMeta callback — detail_resolved', () => {
  test.serial('passes through explicit detail override (caller specified "high")', async () => {
    const meta = await runWithMeta('alice', { detail: 'high' });
    expect(meta!.detail_resolved).toBe('high');
  });

  test.serial('detail_resolved reflects autoDetect output when caller omits detail', async () => {
    const meta = await runWithMeta('alice');
    expect([null, 'low', 'medium', 'high']).toContain(meta!.detail_resolved);
  });
});

describe('hybridSearch onMeta callback — expansion_applied', () => {
  test.serial('false when expansion flag is off', async () => {
    const meta = await runWithMeta('alice', { expansion: false });
    expect(meta!.expansion_applied).toBe(false);
  });

  test.serial('false when OPENAI_API_KEY missing (early-return short-circuits expansion)', async () => {
    const meta = await runWithMeta('alice', {
      expansion: true,
      expandFn: async () => ['alice', 'alice example', 'the person alice'],
    });
    expect(meta!.expansion_applied).toBe(false);
  });
});

describe('onMeta callback omitted', () => {
  test.serial('hybridSearch works without onMeta (existing Cathedral II callers unaffected)', async () => {
    const out = await withoutEmbeddingProvider(() => hybridSearch(engine, 'alice'));
    expect(Array.isArray(out)).toBe(true);
  });
});
