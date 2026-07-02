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

## Minimal working China config

`~/.gbrain/config.json` (mode 0600):

```json
{
  "engine": "postgres",
  "database_url": "postgresql://...",
  "embedding_model": "dashscope:text-embedding-v4",
  "embedding_dimensions": 1536,
  "dashscope_api_key": "sk-...",
  "provider_base_urls": {
    "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
  }
}
```
