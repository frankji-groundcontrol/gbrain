# DashScope Vision Plus unified multimodal rollout

**Status:** resolved
**Date:** 2026-07-13

## Symptom

GBrain's DashScope integration supported `text-embedding-v4` through an
OpenAI-compatible text endpoint, but could not use the selected Vision Plus
model to put text and image inputs in one searchable vector space.

## Root cause

Vision Plus is served by DashScope's native multimodal embedding endpoint,
not the OpenAI-compatible text endpoint. The native API accepts independent
`input.contents` entries and returns indexed embeddings; it must not be used
as a regular primary text embedding model. Existing image storage also had no
way to retain a unified-column vector beside its image-specific vector.

## Resolution

- Registered `tongyi-embedding-vision-plus-2026-03-06` as DashScope's
  multimodal-only model and reject it from `embedding_model`.
- Added the native adapter: derive the multimodal service URL from a
  Workspace-native text endpoint (or compatible-mode base URL), send at most
  20 independent text/image inputs, request 1024 dimensions, and validate
  response indexes and vector width before persistence.
- Persist the Vision Plus image vector in both `embedding_image` and
  `embedding_multimodal`. An unchanged image is re-imported when the stored
  unified vector or model no longer matches the configured multimodal model.
- Make `reindex --multimodal` price text-only backfills from the configured
  model. Unknown pricing is printed as `unavailable`, never `$0.00`.

## Operator rollout

Keep the primary text model as `dashscope:text-embedding-v4` at 1024d. Set
the multimodal model, backfill text, then enable unified search:

```bash
gbrain config set embedding_multimodal_model dashscope:tongyi-embedding-vision-plus-2026-03-06
gbrain reindex --multimodal --yes
gbrain config set search.unified_multimodal true
```

Use a file-plane DashScope base URL and key. For a Workspace-native text URL,
GBrain derives the sibling native multimodal path automatically. Rerun normal
import for existing images after configuring the model. Do not put workspace
IDs, API keys, database URLs, or indexed content into config examples, tests,
or issue records.

## Verification

- `bun test --max-concurrency=1 test/ai/dashscope-workspace-compat-fetch.test.ts test/embedding-dim-check.test.ts`
- `bun test --max-concurrency=1 test/import-image-file.test.ts test/embedding-pricing.test.ts test/unified-multimodal.serial.test.ts`
- `bun run typecheck`
- `bun run build:llms`
