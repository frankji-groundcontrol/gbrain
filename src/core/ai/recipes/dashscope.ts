import type { Recipe } from '../types.ts';

/**
 * Alibaba DashScope (灵积) / Model Studio (百炼). OpenAI-compatible
 * /embeddings endpoint. Hosts text-embedding-v4 (current; Matryoshka-aware
 * 64-2048, 10 texts/request), text-embedding-v3 (Matryoshka up to 1024),
 * and text-embedding-v2 (older, fixed-dim).
 *
 * Reference: https://help.aliyun.com/zh/model-studio/embedding
 *
 * Note: API keys are region-scoped ("不能跨地域混用") — a China (Beijing)
 * console key does NOT work against the international endpoint and vice
 * versa. The international endpoint ships as the default; China-region
 * users point at https://dashscope.aliyuncs.com/compatible-mode/v1 via the
 * file-plane config override in ~/.gbrain/config.json:
 *   "provider_base_urls": { "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1" }
 * (`gbrain config set provider_base_urls.dashscope` writes the DB plane,
 * which the embed pipeline does not read for this key — edit the file.)
 */
export const dashscope: Recipe = {
  id: 'dashscope',
  name: 'Alibaba DashScope (灵积)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  auth_env: {
    required: ['DASHSCOPE_API_KEY'],
    setup_url: 'https://help.aliyun.com/zh/model-studio/getting-started/',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-v4', 'text-embedding-v3', 'text-embedding-v2'],
      default_dims: 1024,
      // v4 additionally supports 1536 and 2048; 2048 is deliberately NOT
      // offered because it exceeds pgvector's HNSW index cap (2000 dims)
      // and would silently land brains in exact-scan-only territory.
      // Per-model validation (v3 caps at 1024) lives in dims.ts, since
      // dims_options is touchpoint-wide, not per-model.
      dims_options: [64, 128, 256, 512, 768, 1024, 1536],
      // Alibaba caps the OpenAI-compat path by item count as well as
      // tokens: v4 accepts at most 10 input texts per request. The
      // gateway splits token-budgeted batches into ≤10-text runs.
      max_batch_items: 10,
      // Beijing documents a 33,000-token per-request budget for v4 but
      // Singapore documents 8,192; declare the conservative bound so one
      // recipe works against either endpoint.
      max_batch_tokens: 8192,
      // text-embedding-v3/v4 mix English + CJK heavily; the tokenizer is
      // closer to Voyage density than OpenAI tiktoken for CJK-dominant
      // content. Conservative chars_per_token=2 leaves headroom.
      chars_per_token: 2,
      // DashScope Vision Plus is native-API-only. Keep it out of `models`
      // (the normal text /embeddings path) and allow it only through
      // gateway.embedMultimodal().
      supports_multimodal: true,
      multimodal_models: ['tongyi-embedding-vision-plus-2026-03-06'],
    },
    reranker: {
      // qwen3-vl-rerank is native-API-only. gateway.rerank() derives the
      // sibling rerank service from the configured Workspace embedding URL;
      // it must never be sent to the OpenAI-compatible embedding surface.
      models: ['qwen3-vl-rerank'],
      default_model: 'qwen3-vl-rerank',
      // GBrain guard, not an Alibaba advertised raw-byte limit. It covers a
      // 10 MiB query image plus four 1 MiB candidates after base64 expansion.
      max_payload_bytes: 20 * 1024 * 1024,
      // A cross-region Workspace request can exceed the generic hot-path 5s.
      // The caller/config may still choose a tighter or looser timeout.
      default_timeout_ms: 20_000,
    },
  },
  setup_hint:
    'Get an API key at https://help.aliyun.com/zh/model-studio/getting-started/, then `export DASHSCOPE_API_KEY=...` (keys are region-scoped; China-region keys need the China base URL via provider_base_urls.dashscope)',
};
