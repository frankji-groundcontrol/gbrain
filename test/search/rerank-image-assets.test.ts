import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeImageCandidateResolver } from '../../src/core/search/rerank.ts';
import type { BrainEngine, FileRow } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 12, 73, 68, 65, 84, 8, 87, 99, 248, 207, 192, 0, 0, 0, 3, 0, 1,
  90, 12, 105, 240, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

let root: string;
let result: SearchResult;
let file: FileRow;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-rerank-assets-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'candidate.png'), PNG_BYTES);
  file = {
    id: 1,
    source_id: 'default',
    page_id: 1,
    page_slug: 'assets/candidate.png',
    filename: 'candidate.png',
    storage_path: 'assets/candidate.png',
    mime_type: 'image/png',
    size_bytes: PNG_BYTES.length,
    content_hash: 'test-image-hash',
    metadata: {},
    created_at: new Date(),
  };
  result = {
    slug: 'assets/candidate.png',
    page_id: 1,
    title: 'candidate.png',
    type: 'image',
    chunk_text: 'OCR fallback text',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1,
    stale: false,
    source_id: 'default',
  };
});

function fakeEngine(): BrainEngine {
  return {
    listAllSources: async () => [{
      id: 'default', name: null, local_path: root, last_sync_at: null, config: {},
    }],
    listFilesForPage: async () => [file],
  } as unknown as BrainEngine;
}

describe('makeImageCandidateResolver', () => {
  test('uses the source-confined image bytes for an image result', async () => {
    const documents = await makeImageCandidateResolver(fakeEngine())([result]);

    expect(documents).toEqual([
      { kind: 'image_base64', data: PNG_BYTES.toString('base64'), mime: 'image/png' },
    ]);
  });

  test('never looks up a file across source identities', async () => {
    const documents = await makeImageCandidateResolver(fakeEngine())([
      { ...result, source_id: 'foreign-source' },
    ]);

    expect(documents).toEqual(['OCR fallback text']);
  });

  test('caps image payloads at four and keeps later candidates as text', async () => {
    const documents = await makeImageCandidateResolver(fakeEngine())(Array.from({ length: 5 }, () => result));

    expect(documents.slice(0, 4).every(doc => typeof doc !== 'string')).toBe(true);
    expect(documents[4]).toBe('OCR fallback text');
  });
});
