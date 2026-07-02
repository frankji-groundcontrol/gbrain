/**
 * DashScope (Alibaba) recipe smoke (Commit 6 of the v0.32 wave).
 * text-embedding-v4 support added 2026-07 (China-region user wave).
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: dashscope', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('dashscope');
    expect(r).toBeDefined();
    expect(r!.id).toBe('dashscope');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(r!.auth_env?.required).toEqual(['DASHSCOPE_API_KEY']);
  });

  test('embedding touchpoint declares text-embedding-v4 first + 1024 default dims', () => {
    const r = getRecipe('dashscope')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models[0]).toBe('text-embedding-v4');
    expect(r.touchpoints.embedding!.models).toContain('text-embedding-v3');
    expect(r.touchpoints.embedding!.models).toContain('text-embedding-v2');
    expect(r.touchpoints.embedding!.default_dims).toBe(1024);
    expect(r.touchpoints.embedding!.dims_options).toEqual([64, 128, 256, 512, 768, 1024, 1536]);
    // Matryoshka: every dims option ≤ 2000 (HNSW-compatible). v4 supports
    // 2048 upstream but that exceeds pgvector's HNSW cap, so it is
    // deliberately not offered.
    for (const d of r.touchpoints.embedding!.dims_options ?? []) {
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  test('default auth: DASHSCOPE_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('dashscope')!;
    const auth = defaultResolveAuth(
      r,
      { DASHSCOPE_API_KEY: 'sk-dashscope-fake' },
      'embedding',
    );
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-dashscope-fake');
  });

  test('default auth: missing DASHSCOPE_API_KEY → AIConfigError', () => {
    const r = getRecipe('dashscope')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('declares chars_per_token + max_batch_tokens for safer batching', () => {
    const r = getRecipe('dashscope')!;
    expect(r.touchpoints.embedding!.max_batch_tokens).toBeGreaterThan(0);
    expect(r.touchpoints.embedding!.chars_per_token).toBeGreaterThan(0);
  });

  test('declares max_batch_items=10 (v4 caps requests at 10 texts)', () => {
    const r = getRecipe('dashscope')!;
    expect(r.touchpoints.embedding!.max_batch_items).toBe(10);
  });

  test('dimsProviderOptions threads dimensions for text-embedding-v3 (Matryoshka)', async () => {
    // Codex finding #1: DashScope text-embedding-v3 is Matryoshka 64-1024.
    // Without `dimensions` on the wire, user-selected non-default dims are
    // silently ignored and the provider returns its default size.
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v3', 512))
      .toEqual({ openaiCompatible: { dimensions: 512 } });
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v3', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
    // text-embedding-v2 is fixed-dim; no passthrough.
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v2', 1024))
      .toBeUndefined();
  });

  test('dimsProviderOptions threads dimensions for text-embedding-v4 (Matryoshka 64-2048)', async () => {
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v4', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v4', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-v4', 64))
      .toEqual({ openaiCompatible: { dimensions: 64 } });
  });

  test('dimsProviderOptions rejects off-list dims for text-embedding-v4', async () => {
    // v4 accepts a DISCRETE dims list (unlike OpenAI's 1..max range); an
    // off-list width would otherwise fail only AFTER the paid API call via
    // the returned-length check.
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(() => dimsProviderOptions('openai-compatible', 'text-embedding-v4', 1000))
      .toThrow(AIConfigError);
    expect(() => dimsProviderOptions('openai-compatible', 'text-embedding-v4', 3000))
      .toThrow(AIConfigError);
  });

  test('dimsProviderOptions rejects >1024 dims for text-embedding-v3', async () => {
    // dims_options is touchpoint-wide, so 1536 (valid for v4) passes init
    // preflight even when the model is v3 — the per-model guard has to
    // catch it before the wire call.
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(() => dimsProviderOptions('openai-compatible', 'text-embedding-v3', 1536))
      .toThrow(AIConfigError);
  });
});
