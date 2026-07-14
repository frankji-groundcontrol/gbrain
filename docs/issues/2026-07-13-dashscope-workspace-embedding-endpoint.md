# DashScope workspace-native embedding endpoint

**Status:** resolved
**Date:** 2026-07-13

## Symptom

`gbrain providers test --model dashscope:text-embedding-v4` reported an
invalid DashScope key, while the same workspace key succeeded against the
workspace's documented embedding endpoint.

## Root cause

The workspace endpoint is not OpenAI-compatible:

```text
.../api/v1/services/embeddings/text-embedding/text-embedding
```

It expects `input.texts` and returns `output.embeddings`. GBrain's DashScope
recipe normally calls `/embeddings` with an OpenAI-shaped body and response.

Separately, `gbrain providers test --model ...` discarded
`provider_base_urls` while overriding the model, so it tested DashScope's
default endpoint rather than the brain's configured workspace endpoint.

## Resolution

- Added a DashScope workspace adapter that rewrites the request path/body and
  normalizes the native response to the OpenAI embedding shape.
- Preserved configured provider base URLs in model-override probes.
- Documented the full workspace-native endpoint in
  [`../ai-providers/dashscope.md`](../ai-providers/dashscope.md).

Use a file-plane provider URL and environment-supplied key; never commit a
key:

```json
"provider_base_urls": {
  "dashscope": "https://<workspace>.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
}
```

```dotenv
DASHSCOPE_API_KEY=...
```

## Verification

- `bun test test/ai/dashscope-workspace-compat-fetch.test.ts`
- `bun test test/providers.test.ts`
- `bun run typecheck`
- `bun src/cli.ts providers test --model dashscope:text-embedding-v4`
