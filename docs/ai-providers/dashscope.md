# DashScope (Alibaba Model Studio) embeddings

DashScope hosts the `text-embedding-v4` family behind an OpenAI-compatible
`/embeddings` endpoint. It is the first-choice embedding provider for
China-region deployments (Voyage/OpenAI/ZeroEntropy all require cross-border
connectivity and payment).

## The three things that bite everyone

**1. API keys are region- AND workspace-scoped.** Alibaba's own docs:
"每个地域有独立的接入域名、API Key 和模型列表，不能跨地域混用" (each region has
its own domain, API key, and model list; they cannot be mixed). A China
(Beijing) console key returns `invalid_api_key` on the international endpoint
and vice versa. On top of that, workspace-dedicated domains
(`{WorkspaceId}.{region}.maas.aliyuncs.com`) only serve models enabled for
that workspace — a key that happily generates images can return
`Model not exist.` for `text-embedding-v4` if the workspace never enabled it.
Verify before configuring:

```bash
curl -sS -X POST "$BASE/embeddings" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-v4","input":"hello","dimensions":1536}'
```

**2. The base-URL override is file-plane only.** The recipe defaults to the
international endpoint (`dashscope-intl.aliyuncs.com`). `gbrain config set
provider_base_urls.dashscope <url>` LOOKS like it works (it validates, prints
"Set ...", and `config get` echoes it back) but writes the DB config table,
which the embed pipeline never reads for this key. Edit `~/.gbrain/config.json`
instead:

```json
"provider_base_urls": {
  "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1"
}
```

(or a workspace domain like
`https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`).
`DASHSCOPE_BASE_URL` in the environment also works.

### Workspace-native embedding endpoint

Some workspace keys use the native embedding service rather than the
OpenAI-compatible path. Set the full service endpoint in the file-plane
config; gbrain rewrites its OpenAI-shaped request and response automatically:

```json
"provider_base_urls": {
  "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
}
```

This endpoint is for embeddings only. It expects `input.texts` and returns
`output.embeddings`, unlike `/compatible-mode/v1/embeddings`.

### Vision Plus unified text-and-image search

`tongyi-embedding-vision-plus-2026-03-06` is a **multimodal-only** model in
GBrain. Keep `text-embedding-v4` as the primary model and use Vision Plus for
the separate shared column at 1024 dimensions:

```json
{
  "embedding_model": "dashscope:text-embedding-v4",
  "embedding_dimensions": 1024,
  "provider_base_urls": {
    "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
  }
}
```

Then configure and backfill the unified column:

```bash
gbrain config set embedding_multimodal_model dashscope:tongyi-embedding-vision-plus-2026-03-06
gbrain reindex --multimodal --yes
gbrain config set search.unified_multimodal true
```

When the file-plane URL is the native text service above, GBrain derives its
same-host multimodal sibling automatically:

```text
/api/v1/services/embeddings/text-embedding/text-embedding
→ /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding
```

The adapter requests 1024 dimensions and sends independent text or image
inputs only—no provider-side fusion. New image imports save the resulting
Vision Plus vector to both `embedding_image` and `embedding_multimodal`.
After enabling the model, rerun ordinary import for existing images to
backfill the unified vector; `reindex --multimodal` backfills existing text
chunks. Do not set Vision Plus as `embedding_model`: the standard text endpoint
cannot serve it.

### Qwen3-VL rerank for text and image search

`qwen3-vl-rerank` is the matching **native-only** DashScope reranker for a
brain that contains text and images. It uses the same Workspace host and
`DASHSCOPE_API_KEY` as the embedding configuration above, but it does **not**
use the embedding endpoint or an OpenAI-compatible rerank route.

Enable it on the DB-backed search configuration plane:

```bash
gbrain config set search.reranker.model dashscope:qwen3-vl-rerank
gbrain config set search.reranker.enabled true
# Optional explicit override; 20 seconds is already the recipe default.
gbrain config set search.reranker.timeout_ms 20000
```

GBrain derives the native rerank sibling from either supported file-plane
DashScope URL, retaining the host and key:

```text
/api/v1/services/embeddings/text-embedding/text-embedding
→ /api/v1/services/rerank/text-rerank/text-rerank

/compatible-mode/v1
→ /api/v1/services/rerank/text-rerank/text-rerank
```

For normal text search, the model reranks text chunks and, when a retrieved
result is an eligible local image asset, can rank that image against the text
query. For `gbrain search-by-image`, it reranks the supplied image against a
mix of returned images and text chunks. Optional text refinement stays in the
existing RRF retrieval step because Alibaba's rerank request accepts one query
modality per request, not a fused image-plus-text query.

This is a deliberately bounded hot-path call: GBrain reads candidate assets
sequentially, sends at most four, and caps each at 1 MiB. Each candidate must
belong to the already selected source and resolve inside that source's
registered `local_path`; missing, unsupported, storage-only, over-cap, or
unsafe paths fall back to the result's text. Video is not sent. A rerank
failure, provider limit, or timeout leaves the initial retrieval order intact.

The selected query, text chunks, and eligible image bytes are sent to your
DashScope Workspace for this paid provider request. They are never placed in
GBrain's rerank audit log; text audit entries use a short hash and image
queries are recorded only as an image marker. Alibaba documents the native
request/response shape and limits (100 text documents, 40 images, 8,000 tokens
per item, and 120,000 tokens per request) in its
[Qwen3-VL rerank API reference](https://help.aliyun.com/en/model-studio/text-rerank-api).

Verify the configuration (this makes a minimal provider request):

```bash
gbrain models doctor --json | jq '.probes[] | select(.touchpoint == "reranker_config")'
```

**3. The key needs to reach daemon-spawned processes.** `DASHSCOPE_API_KEY`
in `~/.zshrc` never reaches MCP-serve/launchd/cron gbrain processes. Use the
file-plane slot (same pattern as `zeroentropy_api_key`):

```json
"dashscope_api_key": "sk-..."
```

Process env still wins when both are set.

## Endpoints (mid-2026)

| Region | Legacy domain | Workspace domain (recommended by Alibaba) |
|---|---|---|
| Beijing | `dashscope.aliyuncs.com` | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` |
| Singapore | `dashscope-intl.aliyuncs.com` (deprecation notice posted) | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` |

All paths are `/compatible-mode/v1` for the OpenAI-compatible surface.

## text-embedding-v4 specifics

- **Dims**: discrete Matryoshka list 2048/1536/1024(default)/768/512/256/128/64.
  The `dimensions` request parameter IS honored on the compatible-mode path
  (unlike some earlier v3 deployments). gbrain validates the configured width
  against the list before the paid call and offers up to **1536** —
  2048 exceeds pgvector's HNSW index cap (2000) and would silently land the
  brain in exact-scan territory.
- **Batching**: at most **10 input texts per request** (independent of
  tokens). The recipe declares `max_batch_items: 10`; the gateway splits
  token-budgeted batches into compliant runs. Per-request token budget is
  33,000 (Beijing) / 8,192 (Singapore) — the recipe declares the conservative
  8,192.
- **Cost**: ¥0.0005/1K tokens on Beijing (≈ $0.07/1M) — pennies per repo.
- **Config**: `gbrain init --embedding-model dashscope:text-embedding-v4
  --embedding-dimensions 1536` (embedding_model/dimensions size the schema,
  so they are init-time choices, not `config set` flips).
- **Query-time deadline**: semantic search embeds the QUERY per call, and the
  default 6s budget is too tight for a cold cross-border round trip — every
  `gbrain query` silently degrades to keyword-only ("No results" for
  paraphrase/CJK queries while exact keywords work). Set
  `gbrain config set search.query_embed_timeout_ms 20000` (this one IS a
  DB-plane search key, unlike the provider keys above).

## Minimal working China config

`~/.gbrain/config.json` (mode 0600):

```json
{
  "engine": "postgres",
  "database_url": "postgresql://...",
  "embedding_model": "dashscope:text-embedding-v4",
  "embedding_dimensions": 1024,
  "dashscope_api_key": "sk-...",
  "provider_base_urls": {
    "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
  }
}
```
