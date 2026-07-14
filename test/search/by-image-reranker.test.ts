import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine, FileRow } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { searchByImage } from '../../src/core/search/by-image.ts';
import type { SearchResult } from '../../src/core/types.ts';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 12, 73, 68, 65, 84, 8, 87, 99, 248, 207, 192, 0, 0, 0, 3, 0, 1,
  90, 12, 105, 240, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const vector = Array.from({ length: 1024 }, () => 0.1);
const originalFetch = globalThis.fetch;
let root: string;
let rerankBody: any;

function result(slug: string, pageId: number, text: string): SearchResult {
  return {
    slug,
    page_id: pageId,
    title: slug,
    type: pageId === 1 ? 'image' : 'note',
    chunk_text: text,
    chunk_source: 'compiled_truth',
    chunk_id: pageId,
    chunk_index: 0,
    score: 1 - pageId * 0.1,
    stale: false,
    source_id: 'default',
  };
}

function fakeEngine(): BrainEngine {
  const imageFile: FileRow = {
    id: 1,
    source_id: 'default',
    page_slug: 'assets/candidate.png',
    page_id: 1,
    filename: 'candidate.png',
    storage_path: 'assets/candidate.png',
    mime_type: 'image/png',
    size_bytes: PNG_BYTES.length,
    content_hash: 'test-image-hash',
    metadata: {},
    created_at: new Date(),
  };
  return {
    getConfig: async (key: string) => ({
      'search.reranker.enabled': 'true',
      'search.reranker.model': 'dashscope:qwen3-vl-rerank',
    } as Record<string, string | undefined>)[key] ?? null,
    searchVector: async () => [
      result('assets/candidate.png', 1, 'image OCR fallback'),
      result('notes/text', 2, 'text candidate'),
    ],
    listAllSources: async () => [{
      id: 'default', name: null, local_path: root, last_sync_at: null, config: {},
    }],
    listFilesForPage: async (pageId: number) => pageId === 1 ? [imageFile] : [],
  } as unknown as BrainEngine;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-by-image-rerank-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'candidate.png'), PNG_BYTES);
  rerankBody = null;
  configureGateway({
    embedding_model: 'dashscope:text-embedding-v4',
    embedding_dimensions: 1024,
    embedding_multimodal_model: 'dashscope:tongyi-embedding-vision-plus-2026-03-06',
    reranker_model: 'dashscope:qwen3-vl-rerank',
    base_urls: {
      dashscope: 'https://workspace-example.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    },
    env: { DASHSCOPE_API_KEY: 'test-key' },
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/multimodal-embedding/')) {
      return new Response(JSON.stringify({ output: { embeddings: [{ index: 0, embedding: vector }] } }), { status: 200 });
    }
    if (target.includes('/rerank/text-rerank/')) {
      rerankBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        output: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGateway();
});

describe('searchByImage — DashScope qwen3-vl-rerank', () => {
  test('reranks the input image against mixed safe image and text candidates', async () => {
    const out = await searchByImage(fakeEngine(), {
      base64: PNG_BYTES.toString('base64'), mime: 'image/png',
    }, { limit: 2 });

    expect(rerankBody.input.query).toEqual({ image: `data:image/png;base64,${PNG_BYTES.toString('base64')}` });
    expect(rerankBody.input.documents).toEqual([
      { image: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
      { text: 'text candidate' },
    ]);
    expect(out.map(item => item.slug)).toEqual(['notes/text', 'assets/candidate.png']);
  });
});
