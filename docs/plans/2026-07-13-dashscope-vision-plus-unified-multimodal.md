# DashScope Vision Plus Unified Multimodal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution with a focused test-first loop. Do not increase test-worker fan-out.

**Goal:** Use `dashscope:tongyi-embedding-vision-plus-2026-03-06` at 1024 dimensions to embed text and images into GBrain's unified multimodal column.

**Architecture:** Keep `dashscope:text-embedding-v4` as the primary text model. Add one DashScope-native multimodal gateway branch for Vision Plus, then persist its image vectors in both the existing image column and the unified column. Text chunks enter the unified column through `gbrain reindex --multimodal`; unchanged historical images re-enter through ordinary import when their stored multimodal model/vector is absent or differs.

**Tech Stack:** Bun, TypeScript, DashScope native HTTP API, pgvector, PGLite/Postgres parity tests.

**Status:** completed

**Supersedes:** the earlier Qwen3-only design; this record is the source of
truth for the selected Vision Plus unified text-and-image scope.

**Privacy risk:** Native provider calls carry only text chunks or image bytes supplied for indexing. Never record workspace IDs, API keys, database URLs, or user content in tests, docs, plan receipts, or commits.

---

## Fixed configuration

```json
{
  "embedding_model": "dashscope:text-embedding-v4",
  "embedding_dimensions": 1024,
  "embedding_multimodal_model": "dashscope:tongyi-embedding-vision-plus-2026-03-06"
}
```

Keep the existing file-plane DashScope Workspace base URL. If it is the native
text endpoint, derive the sibling native multimodal endpoint:

```text
/api/v1/services/embeddings/text-embedding/text-embedding
→ /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding
```

The adapter sends independent inputs only. Each text chunk is `{ "text": "…" }`;
each image is `{ "image": "data:<mime>;base64,…" }`. Do not use DashScope
fusion: GBrain requires one embedding per input for batched indexing.

## File map

| File | Change |
|---|---|
| `src/core/ai/recipes/dashscope.ts` | Declare Vision Plus as DashScope's only multimodal model without making it a normal text-embedding model. |
| `src/core/ai/gateway.ts` | Add the native DashScope multimodal endpoint, payload/response conversion, 1024d validation, and a 20-input cap before the generic OpenAI-compatible branch. |
| `src/core/types.ts`, `src/core/utils.ts` | Carry `embedding_multimodal` on chunk inputs and DB reads. |
| `src/core/postgres-engine.ts`, `src/core/pglite-engine.ts` | Write and preserve `embedding_multimodal` in matching chunk-upsert SQL. |
| `src/core/import-file.ts` | Store a newly embedded image in both image and unified columns; re-import unchanged images when the current multimodal vector/model is missing. |
| `src/core/embedding-pricing.ts`, `src/commands/reindex-multimodal.ts` | Use Vision Plus text pricing for text-only unified reindex estimates and print the configured model rather than Voyage. |
| `test/ai/dashscope-workspace-compat-fetch.test.ts` | Test native Vision Plus endpoint resolution, payload, response ordering, and dimension rejection. |
| `test/import-image-file.test.ts`, `test/unified-multimodal.serial.test.ts`, `test/embedding-dim-check.test.ts` | Cover dual-column image persistence, unchanged-image backfill, Vision Plus preflight, and unified retrieval routing. |
| `docs/ai-providers/dashscope.md`, `docs/integrations/embedding-providers.md`, `docs/architecture/KEY_FILES.md`, `docs/issues/README.md`, `docs/issues/2026-07-13-dashscope-vision-plus-multimodal.md` | Document setup, constraints, and the resolved integration record. |

### Task 1: Lock the native provider contract with failing tests

**Files:**

- Modify: `test/ai/dashscope-workspace-compat-fetch.test.ts`
- Modify: `test/embedding-dim-check.test.ts`

- [x] Add a test that calls the exported DashScope multimodal test seam with
  the Workspace-native text URL, one text input, and one base64 PNG input.
  Assert this request exactly:

  ```ts
  {
    model: 'tongyi-embedding-vision-plus-2026-03-06',
    input: { contents: [
      { text: 'roadmap' },
      { image: 'data:image/png;base64,aGVsbG8=' },
    ] },
    parameters: { dimension: 1024 },
  }
  ```

  Assert the URL ends in
  `/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`,
  retains `Authorization: Bearer test-key`, and returns vectors ordered by
  response `index`, not upstream array order.

- [x] Add a failing test for a 768d native response. It must throw an
  `AIConfigError` naming Vision Plus and 1024 dimensions.

- [x] Add a failing `resolveSchemaMultimodalDim` assertion:

  ```ts
  expect(resolveSchemaMultimodalDim({
    embedding_multimodal_model: 'dashscope:tongyi-embedding-vision-plus-2026-03-06',
  })).toMatchObject({ ok: true, provider: 'dashscope', dim: 1024 });
  ```

- [x] Run the two focused files and confirm the new cases fail because
  Vision Plus is not yet recognized:

  ```bash
  bun test test/ai/dashscope-workspace-compat-fetch.test.ts test/embedding-dim-check.test.ts
  ```

### Task 2: Implement the minimal DashScope native multimodal path

**Files:**

- Modify: `src/core/ai/recipes/dashscope.ts`
- Modify: `src/core/ai/gateway.ts`

- [x] In the DashScope embedding touchpoint, set:

  ```ts
  supports_multimodal: true,
  multimodal_models: ['tongyi-embedding-vision-plus-2026-03-06'],
  ```

  Leave the ordinary `models` list text-only. This prevents Vision Plus from
  being presented as a normal `embedding_model` backed by the incompatible
  OpenAI-shaped text endpoint.

- [x] Add a `dashscope` branch in `embedMultimodal()` **before** the generic
  `openai-compatible` branch. It must:

  1. resolve bearer auth through the recipe's canonical auth path;
  2. derive the native multimodal URL from either a Workspace-native text URL
     or a `/compatible-mode/v1` base URL on the same host;
  3. send at most 20 independent inputs per request;
  4. request `parameters.dimension = 1024`;
  5. validate unique integer response indexes `0..batch.length - 1` and
     exactly 1024 values per vector; and
  6. retain the existing 60-second abort, config-error, and transient-error
  classification behavior.

- [x] In the normal `resolveEmbeddingProvider()` path, reject Vision Plus with
  an `AIConfigError` explaining that it is multimodal-only and belongs in
  `embedding_multimodal_model`. The adapter must never silently send that
  model to DashScope's OpenAI-compatible text endpoint.

- [x] Export only the narrow URL/payload test seam through `__testing`; do not
  add provider-specific public API.

- [x] Re-run the focused tests and confirm they pass:

  ```bash
  bun test test/ai/dashscope-workspace-compat-fetch.test.ts test/embedding-dim-check.test.ts
  ```

### Task 3: Persist Vision Plus image vectors in both columns

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/utils.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/import-file.ts`
- Modify: `test/import-image-file.test.ts`

- [x] Extend `ChunkInput` and `Chunk` with optional
  `embedding_multimodal?: Float32Array`; teach `rowToChunk` to parse that
  column when present.

- [x] In both engines, add `embedding_multimodal` to the chunk INSERT column
  list and value parameters. The `ON CONFLICT` clause must preserve an existing
  vector when the incoming value is null:

  ```sql
  embedding_multimodal = COALESCE(
    EXCLUDED.embedding_multimodal,
    content_chunks.embedding_multimodal
  )
  ```

  Keep the two SQL implementations structurally identical apart from their
  existing driver syntax.

- [x] In `importImageFile`, retain the one Vision Plus image embedding and
  assign it to both columns:

  ```ts
  embedding_image: embedding,
  embedding_multimodal: embedding,
  model: getMultimodalModel(),
  ```

  For an unchanged image hash, skip only when the stored chunk already has an
  `embedding_multimodal` vector from the configured multimodal model. Otherwise
  reprocess that one image, so a normal import backfills old image rows without
  copying vectors from another provider's latent space.

- [x] Add tests that import a tiny fixture PNG with a stubbed 1024d embedding,
  then query its chunk and assert both vector columns are populated. Re-import
  the unchanged file after clearing its unified vector and assert it embeds
  again; re-import once more with both vector and model present and assert it
  skips.

- [x] Run the image and unified focused tests with one Bun worker:

  ```bash
  GBRAIN_TEST_MAX_CONCURRENCY=1 bun test test/import-image-file.test.ts test/unified-multimodal.serial.test.ts
  ```

### Task 4: Make unified text reindexing model-aware

**Files:**

- Modify: `src/core/embedding-pricing.ts`
- Modify: `src/commands/reindex-multimodal.ts`
- Modify: `src/cli.ts`
- Modify: `test/embedding-pricing.test.ts`
- Modify: `test/unified-multimodal.serial.test.ts`

- [x] Add both of these verified token-price entries to
  `EMBEDDING_PRICING`, with the source URL and verification date in the
  adjacent comments:

  ```ts
  'voyage:voyage-multimodal-3': { pricePerMTok: 0.18 },
  'dashscope:tongyi-embedding-vision-plus-2026-03-06': { pricePerMTok: 0.07 },
  ```

  Vision Plus' source price is ¥0.0005 / 1K tokens, converted at the same
  documented 7.1 CNY/USD approximation already used for DashScope Text V4.
  Use this value only for text chunks; image ingestion is charged at import
  time and cannot be estimated from text length.

- [x] Replace the literal Voyage price and model label in
  `runReindexMultimodal()` with the configured
  `embedding_multimodal_model` and `lookupEmbeddingPrice()`. Widen
  `cost_usd_estimate` to `number | null`; format null as `unavailable` in
  `src/cli.ts`. An unknown configured price must never render as `$0.00`.

- [x] Add tests proving Vision Plus produces a nonzero text-reindex estimate
  and that an unknown model yields `cost_usd_estimate: null`; the CLI maps a
  null estimate to `unavailable` rather than rendering `$0.00`.

- [x] Run:

  ```bash
  GBRAIN_TEST_MAX_CONCURRENCY=1 bun test test/embedding-pricing.test.ts test/unified-multimodal.serial.test.ts
  ```

### Task 5: Document and verify the completed configuration

**Files:**

- Modify: `docs/ai-providers/dashscope.md`
- Modify: `docs/integrations/embedding-providers.md`
- Modify: `docs/architecture/KEY_FILES.md`
- Create: `docs/issues/2026-07-13-dashscope-vision-plus-multimodal.md`
- Modify: `docs/issues/README.md`
- Modify: `docs/README.md`
- Modify: `docs/plans/README.md`
- Modify: `llms-full.txt` (generated)

- [x] Document the exact split-model configuration, the Workspace-native
  endpoint derivation, the 1024d requirement, and these operational steps:

  ```bash
  gbrain config set embedding_multimodal_model dashscope:tongyi-embedding-vision-plus-2026-03-06
  gbrain reindex --multimodal --yes
  gbrain config set search.unified_multimodal true
  ```

  State that initial images populate both columns and that old images are
  backfilled by rerunning import after configuring Vision Plus. Do not include
  real endpoints or credentials.

- [x] Record the native-API mismatch, the adapter contract, and validation
  commands in the dated issue record; add it to both documentation indexes.

- [x] Regenerate the documentation bundle:

  ```bash
  bun run build:llms
  ```

- [x] Run the focused regression suite, typecheck, and whitespace check:

  ```bash
  GBRAIN_TEST_MAX_CONCURRENCY=1 bun test \
    test/ai/dashscope-workspace-compat-fetch.test.ts \
    test/embedding-dim-check.test.ts \
    test/import-image-file.test.ts \
    test/embedding-pricing.test.ts \
    test/unified-multimodal.serial.test.ts
  bun run typecheck
  git diff --check
  ```

## Completion criteria

- Vision Plus is accepted only as `embedding_multimodal_model` and always
  returns 1024d vectors to GBrain.
- New and backfilled image imports place the same Vision Plus vector in
  `embedding_image` and `embedding_multimodal`.
- `reindex --multimodal` embeds text chunks with Vision Plus and reports a
  model-correct cost estimate.
- With `search.unified_multimodal=true`, a text query searches a shared Vision
  Plus space containing both text and image chunks.
- Focused tests pass with a single Bun worker; no live provider request or
  secret is needed for verification.

## Execution receipt

- `bun run build:llms`
- `GBRAIN_TEST_MAX_CONCURRENCY=1 bun test --max-concurrency=1` over the five
  focused files: 68 passing tests.
- `bun run typecheck`
- `git diff --check`
