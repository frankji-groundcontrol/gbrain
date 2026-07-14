import { afterEach, describe, expect, test } from 'bun:test';
import { __testing } from '../../src/core/ai/gateway.ts';

const endpoint = 'https://llm-example.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
const visionPlus = 'tongyi-embedding-vision-plus-2026-03-06';
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

describe('DashScope workspace embedding adapter', () => {
  test('rewrites the native request and response into the OpenAI embedding shape', async () => {
    let request: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return new Response(JSON.stringify({
        output: { embeddings: [{ embedding: [0.1, 0.2], text_index: 0 }] },
        usage: { total_tokens: 3 },
      }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const response = await __testing.dashscopeWorkspaceCompatFetch(
      `${endpoint}/embeddings`,
      { method: 'POST', body: JSON.stringify({ model: 'text-embedding-v4', input: ['hello'], dimensions: 1024 }) },
    );

    expect(request).toEqual({
      url: endpoint,
      body: { model: 'text-embedding-v4', input: { texts: ['hello'] } },
    });
    expect(await response.json()).toEqual({
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      usage: { total_tokens: 3, prompt_tokens: 3 },
    });
  });

  test('preserves authorization when the SDK supplies a Request object', async () => {
    let request: { method: string; authorization: string | null; body: unknown } | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      request = {
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(JSON.stringify({ output: { embeddings: [] }, usage: { total_tokens: 0 } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await __testing.dashscopeWorkspaceCompatFetch(new Request(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: { authorization: 'Bearer workspace-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-v4', input: ['hello'] }),
    }));

    expect(request).toEqual({
      method: 'POST',
      authorization: 'Bearer workspace-key',
      body: { model: 'text-embedding-v4', input: { texts: ['hello'] } },
    });
  });
});

describe('DashScope Vision Plus multimodal adapter', () => {
  test('maps independent text and image inputs to the native endpoint in response-index order', async () => {
    let request: { url: string; authorization: string | null; body: unknown } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = {
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(JSON.stringify({
        output: {
          embeddings: [
            { index: 1, embedding: Array.from({ length: 1024 }, () => 0.2) },
            { index: 0, embedding: Array.from({ length: 1024 }, () => 0.1) },
          ],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const embeddings = await __testing.dashscopeWorkspaceMultimodalEmbed({
      baseUrl: endpoint,
      apiKey: 'test-key',
      model: visionPlus,
      inputs: [
        { kind: 'text', text: 'roadmap' },
        { kind: 'image_base64', mime: 'image/png', data: 'aGVsbG8=' },
      ],
    });

    expect(request).toEqual({
      url: 'https://llm-example.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
      authorization: 'Bearer test-key',
      body: {
        model: visionPlus,
        input: {
          contents: [
            { text: 'roadmap' },
            { image: 'data:image/png;base64,aGVsbG8=' },
          ],
        },
        parameters: { dimension: 1024 },
      },
    });
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]?.[0]).toBeCloseTo(0.1);
    expect(embeddings[1]?.[0]).toBeCloseTo(0.2);
  });

  test('rejects a non-1024d native response before storage', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      output: { embeddings: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }] },
    }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    await expect(__testing.dashscopeWorkspaceMultimodalEmbed({
      baseUrl: endpoint,
      apiKey: 'test-key',
      model: visionPlus,
      inputs: [{ kind: 'text', text: 'roadmap' }],
    })).rejects.toThrow(/tongyi-embedding-vision-plus-2026-03-06.*1024/i);
  });
});
