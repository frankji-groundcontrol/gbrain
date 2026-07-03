# DashScope text-embedding-v4 support

- **Shipped:** 2026-07-03 (branch `franky`)
- **Status:** shipped
- **Scope:** embedding provider — Alibaba DashScope / Model Studio

## What changed

`dashscope:text-embedding-v4` is now a first-class embedding model. The
DashScope recipe leads with v4, offers Matryoshka widths up to 1536, honors the
provider's 10-texts-per-request cap, and carries real pricing. Two adjacent
fixes make it usable from a China-region account:

- **File-plane `dashscope_api_key`** folds into the gateway env, so a key in
  `~/.gbrain/config.json` reaches daemon/launchd/cron gbrain processes that
  never inherit shell exports (process env `DASHSCOPE_API_KEY` still wins).
- **`DASHSCOPE_BASE_URL`** joins the overridable base-URL env vars, alongside
  the existing file-plane `provider_base_urls.dashscope`, so China-region users
  can point at the Beijing endpoint.

## Why

DashScope is the practical embedding provider for China-region deployments
(Voyage/OpenAI/ZeroEntropy all require cross-border connectivity and payment).
v3 was the newest model the recipe knew; v4 is current. The batching and
key-plane fixes close the footguns that made a first attempt silently fail.

## How to use

```bash
gbrain init --embedding-model dashscope:text-embedding-v4 --embedding-dimensions 1536
```

`~/.gbrain/config.json` (file plane — `gbrain config set` writes a DB plane the
embed pipeline does not read for these keys):

```json
"dashscope_api_key": "sk-...",
"provider_base_urls": { "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" }
```

Watch out for two provider-side scoping rules: keys are **region-scoped** (a
Beijing key 401s on the international endpoint) and **workspace-scoped** (a key
can return `Model not exist.` for v4 if that workspace never enabled it). Verify
the exact endpoint+model+key combination with a `curl` before wiring it. Full
walkthrough: [`../ai-providers/dashscope.md`](../ai-providers/dashscope.md).

## Details

- **Dimensions:** discrete Matryoshka list (2048/1536/1024 default/768/…/64).
  The recipe offers up to **1536** — 2048 is deliberately excluded because it
  exceeds pgvector's HNSW index cap (2000) and would drop the brain to
  exact-scan-only. `dims_options` is touchpoint-wide, so per-model validation
  (v4's discrete list; v3 capped at 1024) lives in `dims.ts` and fails fast with
  a fix hint before the paid API call.
- **`max_batch_items`:** a new `EmbeddingTouchpoint` field (general, not
  dashscope-only). DashScope v4 accepts at most 10 input texts per request; the
  gateway now item-count-splits each token-budgeted batch into ≤N-text runs, so
  small-chunk batches don't trip the provider's count limit and burn
  recursive-halving retries.
- **Pricing:** `dashscope:text-embedding-v4` / `-v3` at ~$0.07/1M tokens
  (Beijing ¥0.0005/1K).

## Under the hood

- `src/core/ai/recipes/dashscope.ts` — recipe (models, dims_options, batching).
- `src/core/ai/dims.ts` — `isValidDashScopeV4Dim` + v3 range check.
- `src/core/ai/types.ts` / `gateway.ts` — `max_batch_items` field + item-split.
- `src/core/ai/build-gateway-config.ts`, `src/core/config.ts` — key/base-URL fold.
- `src/core/embedding-pricing.ts` — pricing entries.
- KEY_FILES entries: `recipes/dashscope.ts`, `dims.ts`, `types.ts`, `gateway.ts`,
  `build-gateway-config.ts`.

## Tests

`test/ai/recipe-dashscope.test.ts` (recipe shape, v4 dims, batching),
`test/ai/adaptive-embed-batch.test.ts` (max_batch_items item-count split),
`test/embedding-pricing.test.ts`.
