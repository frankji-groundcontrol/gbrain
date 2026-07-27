// Phase 8 (D1-D3 + cherry-2 + cherry-3 + Sec5 + Eng-1C): importImageFile
// + withImportTransaction shared helper. Verifies the core ingest path on
// PGLite without a real Voyage API key (uses noEmbed=true).
//
// Real-API embedding is exercised in test/e2e/voyage-multimodal.test.ts (gated
// VOYAGE_API_KEY) and the dual-engine parity gate lands in Phase 10.

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, isImageFilePath, pLimit, SUPPORTED_IMAGE_EXTS } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpDir: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-img-test-'));
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

describe('isImageFilePath / SUPPORTED_IMAGE_EXTS', () => {
  test('recognizes all supported extensions', () => {
    for (const ext of SUPPORTED_IMAGE_EXTS) {
      expect(isImageFilePath(`some/path/foo${ext}`)).toBe(true);
      expect(isImageFilePath(`some/path/FOO${ext.toUpperCase()}`)).toBe(true);
    }
  });

  test('rejects non-image extensions', () => {
    expect(isImageFilePath('readme.md')).toBe(false);
    expect(isImageFilePath('script.ts')).toBe(false);
    expect(isImageFilePath('image_no_ext')).toBe(false);
  });
});

describe('pLimit semaphore (Eng-1C)', () => {
  test('serializes work to the configured concurrency', async () => {
    const limit = pLimit(2);
    const order: string[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    const tasks = [
      limit(async () => { order.push('A-start'); await sleep(20); order.push('A-end'); }),
      limit(async () => { order.push('B-start'); await sleep(20); order.push('B-end'); }),
      limit(async () => { order.push('C-start'); await sleep(5);  order.push('C-end'); }),
      limit(async () => { order.push('D-start'); await sleep(5);  order.push('D-end'); }),
    ];

    await Promise.all(tasks);

    // First two start before either finishes (concurrency=2). C/D wait.
    expect(order.indexOf('A-start')).toBeLessThan(order.indexOf('C-start'));
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('C-start'));
    // All four eventually run.
    expect(order.filter(s => s.endsWith('-end')).length).toBe(4);
  });

  test('propagates rejections without leaving the slot held', async () => {
    const limit = pLimit(1);
    const reject = limit(async () => { throw new Error('boom'); });
    let caught: unknown;
    try { await reject; } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('boom');
    // Slot must release; the next call should run promptly.
    const ok = await limit(async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('importImageFile happy path (noEmbed)', () => {
  test('imports a PNG fixture, creates a single image chunk + files row', async () => {
    // Copy the tiny.avif fixture as a stand-in for a generic image; the test
    // runs noEmbed:true so no decode/voyage call fires. Rename to .png so the
    // dispatcher routes correctly without needing actual decode.
    const target = join(tmpDir, 'photo.png');
    copyFileSync('test/fixtures/images/tiny.avif', target);

    const result = await importImageFile(engine, target, 'originals/photos/photo.png', { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(1);

    const page = await engine.getPage('originals/photos/photo.png');
    expect(page).not.toBeNull();
    expect(page!.type).toBe('image');
    expect((page!.frontmatter as Record<string, unknown>).mime_type).toBe('image/png');

    const file = await engine.getFile('default', 'originals/photos/photo.png');
    expect(file).not.toBeNull();
    expect(file!.filename).toBe('photo.png');
    expect(file!.mime_type).toBe('image/png');
    expect(file!.page_id).toBe(page!.id);

    const chunks = await engine.getChunks('originals/photos/photo.png');
    expect(chunks.length).toBe(1);
    expect((chunks[0] as { chunk_source: string }).chunk_source).toBe('image_asset');
    // chunk_text falls back to filename when OCR is off (default).
    expect(chunks[0].chunk_text).toBe('photo.png');
  });

  test('idempotent on content_hash: re-import same bytes returns skipped', async () => {
    const target = join(tmpDir, 'photo2.png');
    writeFileSync(target, Buffer.from('fake-png-bytes-stable'));

    const r1 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r1.status).toBe('imported');
    const r2 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r2.status).toBe('skipped');
  });

  test('routes page, chunks, and file metadata to the requested source (#2706)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ['image-source', 'Image Source'],
    );
    const target = join(tmpDir, 'source-photo.png');
    writeFileSync(target, Buffer.from('fake-png-bytes-source-scoped'));

    const result = await importImageFile(engine, target, 'photos/source-photo.png', {
      noEmbed: true,
      sourceId: 'image-source',
    });

    expect(result.status).toBe('imported');
    expect(await engine.getPage('photos/source-photo.png', { sourceId: 'default' })).toBeNull();
    const page = await engine.getPage('photos/source-photo.png', { sourceId: 'image-source' });
    expect(page).not.toBeNull();
    expect(await engine.getChunks('photos/source-photo.png', { sourceId: 'default' })).toHaveLength(0);
    expect(await engine.getChunks('photos/source-photo.png', { sourceId: 'image-source' })).toHaveLength(1);
    expect(await engine.getFile('default', 'photos/source-photo.png')).toBeNull();
    expect(await engine.getFile('image-source', 'photos/source-photo.png')).not.toBeNull();
  });

  test('refuses oversized files (>20MB)', async () => {
    const target = join(tmpDir, 'huge.png');
    // Write a 21MB file. Buffer.alloc is fast.
    writeFileSync(target, Buffer.alloc(21 * 1024 * 1024));
    const result = await importImageFile(engine, target, 'photos/huge.png', { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/Image too large/);
  });
});

describe('importImageFile unified multimodal image embeddings', () => {
  test('writes one Vision Plus image vector into both image columns and backfills an unchanged image missing the unified vector', async () => {
    let embedCalls = 0;
    globalThis.fetch = (async () => {
      embedCalls++;
      return new Response(JSON.stringify({
        output: { embeddings: [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0.25) }] },
      }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    configureGateway({
      embedding_model: 'dashscope:text-embedding-v4',
      embedding_dimensions: 1024,
      embedding_multimodal_model: 'dashscope:tongyi-embedding-vision-plus-2026-03-06',
      base_urls: {
        dashscope: 'https://llm-example.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
      },
      env: { DASHSCOPE_API_KEY: 'test-key' },
    });

    const target = join(tmpDir, 'vision-plus.png');
    writeFileSync(target, Buffer.from('vision-plus-image'));
    const slug = 'photos/vision-plus.png';

    expect(await importImageFile(engine, target, slug)).toMatchObject({ status: 'imported', chunks: 1 });
    expect(embedCalls).toBe(1);
    const stored = await engine.executeRaw<{ image: boolean; unified: boolean; model: string }>(
      `SELECT embedding_image IS NOT NULL AS image,
              embedding_multimodal IS NOT NULL AS unified,
              model
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'photos/vision-plus.png' AND p.source_id = 'default'`,
    );
    expect(stored).toEqual([{
      image: true,
      unified: true,
      model: 'dashscope:tongyi-embedding-vision-plus-2026-03-06',
    }]);

    await engine.executeRaw(
      `UPDATE content_chunks SET embedding_multimodal = NULL
       WHERE page_id = (SELECT id FROM pages WHERE slug = 'photos/vision-plus.png' AND source_id = 'default')`,
    );
    expect(await importImageFile(engine, target, slug)).toMatchObject({ status: 'imported', chunks: 1 });
    expect(embedCalls).toBe(2);

    expect(await importImageFile(engine, target, slug)).toMatchObject({ status: 'skipped', chunks: 0 });
    expect(embedCalls).toBe(2);
  });
});
