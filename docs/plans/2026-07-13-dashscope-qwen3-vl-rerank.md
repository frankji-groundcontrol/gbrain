# DashScope Qwen3-VL Rerank Implementation Plan

> **For implementation:** use a focused test-first loop and one Bun test worker.
> Do not start background embedding, import, or reindex work for this change.

**Status:** completed

**Goal:** Add `dashscope:qwen3-vl-rerank` as the same-Workspace native
DashScope reranker for ordinary text search and image-as-query search. It must
rerank text and image candidates, preserve GBrain's fail-open retrieval
contract, and never add video handling.

**Architecture:** Extend the existing rerank gateway just enough to represent
text and base64-image content. The existing `rerank()` call continues to serve
text-only providers unchanged; when its selected model is
`dashscope:qwen3-vl-rerank`, it dispatches to DashScope's native rerank endpoint
and response shape. `hybridSearch` passes a bounded, source-root-confined image
candidate resolver only for this model. `searchByImage` passes the in-memory
query image through the same rerank stage. Candidates whose source asset is
unavailable, oversized, unsupported, or outside the source root fall back to
their existing chunk text; any upstream failure returns the original retrieval
order.

**Provider contract:** Alibaba's current API documents native-only
`qwen3-vl-rerank` at
`/api/v1/services/rerank/text-rerank/text-rerank`, with Bearer auth, an
`input.query` and `input.documents` multimodal payload, and results at
`output.results`. It accepts a text or image query, text/image documents, up to
100 text documents or 40 image documents, 8,000 tokens per item, and 120,000
tokens per request. GBrain deliberately excludes video even though the provider
also supports it. Source: [Alibaba Model Studio text rerank API](https://help.aliyun.com/en/model-studio/text-rerank-api).

**Privacy risk:** A rerank request sends the selected query, text chunks, and
up to four eligible local image candidates to the configured DashScope
Workspace. Do not write workspace IDs, endpoint URLs, keys, image data, query
text, or source paths to docs, tests, logs, audit records, or commits. The
existing audit remains hash-only for text queries; image queries use an opaque
type marker instead of bytes.

---

## Fixed user configuration

Keep the existing file-plane DashScope API key and Workspace text-embedding
base URL. The reranker derives a sibling native path on the same host; it does
not use the OpenAI-compatible embedding route.

```bash
gbrain config set search.reranker.model dashscope:qwen3-vl-rerank
gbrain config set search.reranker.enabled true
gbrain config set search.reranker.timeout_ms 20000
```

No embedding model or schema change is required. `text-embedding-v4` remains
the normal text embedding model and Vision Plus remains the unified
text-and-image embedding model.

## Fixed scope and limits

- Text query → text and eligible image candidates: supported.
- Image query → text and eligible image candidates: supported.
- An image query with optional text refinement keeps its existing RRF text
  refinement; reranking uses the image because the provider query field accepts
  one modality per call.
- Video candidates and video queries: deliberately unsupported.
- At most four locally readable candidate images, each at most 1 MiB, are sent
  per request. Later/unreadable image candidates are represented by their
  chunk text. This GBrain bound contains memory, disk reads, network payload,
  and paid request size; it is stricter than Alibaba's 40-image ceiling.
- The existing input image cap remains in force. A 20 MiB native request-body
  guard covers the input image plus bounded candidate images after base64
  expansion. Oversize requests fail open without HTTP.
- Candidate asset reads are allowed only when the file's real path is inside
  its registered `sources.local_path`. This applies to local and remote
  searches only after the existing source-grant resolver selected candidates;
  a missing source root or storage-backed-only asset degrades to text.
- Candidate files are selected only when the `files.source_id` matches the
  result's resolved source. A result missing source identity never causes a
  best-effort cross-source lookup; it remains a text candidate.

## File map

| File | Change |
|---|---|
| `src/core/ai/types.ts` | Describe the native multimodal reranker capability without weakening the generic reranker contract. |
| `src/core/ai/recipes/dashscope.ts` | Declare `qwen3-vl-rerank`, its native payload guard, and a practical default timeout. |
| `src/core/ai/gateway.ts` | Add discriminated text/image rerank content, native DashScope URL derivation, request/response conversion, validation, timeout selection, and error/budget parity. |
| `src/core/search/image-loader.ts` | Add a narrowly scoped, realpath-confined source-asset loader that reuses magic-byte and byte-cap validation. |
| `src/core/search/rerank.ts` | Resolve a bounded image representation for image-page results, retain text fallback, preserve fail-open audit/reordering behavior. |
| `src/core/search/hybrid.ts` | Supply the source-scoped candidate resolver to text-query reranking. |
| `src/core/search/by-image.ts` | Apply the same resolved reranker after image/text RRF and send the incoming image as its query. |
| `test/ai/rerank.test.ts` | Pin DashScope native URL, headers, payload, response mapping, limits, timeout, and generic-provider non-regression. |
| `test/cross-modal-phase2.test.ts` (or a focused new sibling) | Pin source-root confinement, image-candidate fallback, and no raw path leak. |
| `test/search/hybrid-reranker-integration.serial.test.ts` | Pin text-query → image-candidate payload and unchanged generic rerank behavior. |
| `test/search-by-image-op.test.ts` | Pin image-query reranking, mixed text/image candidates, and fail-open behavior through the operation boundary. |
| `docs/ai-providers/dashscope.md` | Document native endpoint derivation, setup, constraints, privacy, and verification. |
| `docs/architecture/KEY_FILES.md`, `docs/architecture/RETRIEVAL.md` | Update current rerank/image-search behavior and safe asset-resolution invariant. |
| `docs/plans/README.md` | Add this live plan record. |

## TDD execution checklist

### 1. Lock the DashScope native wire contract with failing tests

- [x] Add a `dashscope:qwen3-vl-rerank` test configuration with a synthetic
  key and a Workspace-native **text embedding** URL.
- [x] Assert reranking text sends exactly:

  ```ts
  {
    model: 'qwen3-vl-rerank',
    input: {
      query: { text: 'query' },
      documents: [{ text: 'first' }, { text: 'second' }],
    },
    parameters: { return_documents: false },
  }
  ```

  and posts to the same host's native rerank endpoint with the existing
  DashScope Bearer key.
- [x] Assert a mixed image payload uses a `data:image/png;base64,...` value,
  maps `output.results`, rejects malformed native output, and classifies 401,
  429, timeout, and body-over-cap like every other reranker.
- [x] Assert text-only ZeroEntropy/llama-compatible wire shapes remain
  unchanged.
- [x] Run the focused file with one worker and confirm the new cases fail
  before the implementation.

### 2. Implement the minimal native adapter

- [x] Add the DashScope reranker recipe declaration. It must not put the
  model in the embedding model list or change existing embedding routing.
- [x] Introduce a small discriminated content type: text or base64 image.
  Keep the public text call shape valid for all existing callers.
- [x] Branch only `dashscope:qwen3-vl-rerank` to a native adapter before the
  generic ZE-compatible request path. Derive the sibling rerank URL from
  either the configured Workspace native embedding endpoint or
  `/compatible-mode/v1`; reject unrelated base paths with a paste-ready
  configuration error.
- [x] Use recipe auth resolution, `return_documents: false`, the 20 MiB
  request-body preflight, 100-document/40-image provider checks, response
  index validation, and `input.timeoutMs ?? recipe default ?? 5000` timeout
  precedence. Preserve existing budget reservation/recording and
  `RerankError` classification.
- [x] Re-run the focused gateway tests.

### 3. Add safe, bounded candidate-image resolution

- [x] Add a source-asset loader that verifies the asset and its
  `sources.local_path` root with the existing symlink-safe
  `isPathContained()` primitive before loading. Reuse `loadImageInput` for
  MIME sniffing and use a 1 MiB rerank-candidate cap.
- [x] In reranking, map image pages to no more than four eligible image
  documents; map all other results and every resolution failure to
  `chunk_text || title`. Do not expose path, file metadata, or bytes in the
  result or audit log.
- [x] Thread `sourceId`/`sourceIds` unchanged from `hybridSearch` and
  `searchByImage`; do not hand-roll source-grant filtering.
- [x] Prove traversal attempts, symlink escapes, missing roots/files,
  unsupported media, and over-cap files fall back to text without an HTTP
  image field.

### 4. Connect both retrieval paths

- [x] In ordinary hybrid text search, pass the bounded resolver into
  `applyReranker`; ordinary models still receive strings and DashScope Qwen
  receives rich candidates only when available.
- [x] In `searchByImage`, resolve the mode reranker after RRF/dedup, use the
  loaded image as the rerank query, and pass the same source-scoped candidate
  resolver. Optional text refinement remains an RRF input rather than an
  unsupported dual-modality rerank query.
- [x] Preserve original order on any candidate-loader or provider error and
  preserve the current tail/top-N behavior.
- [x] Test text→image, image→text/image, source isolation, generic-provider
  non-regression, and fail-open fallback with no live network calls.

### 5. Documentation and verification

- [x] Document the three configuration commands, endpoint derivation, native
  API distinction, no-video scope, four-image/1 MiB bounded behavior, and
  DashScope data-sharing/privacy implications in `docs/ai-providers/dashscope.md`.
- [x] Update architecture references to describe the current behavior only;
  do not append release-history narration.
- [x] Run focused tests with `GBRAIN_TEST_MAX_CONCURRENCY=1`, then typecheck
  and `git diff --check`. Run the relevant PGLite integration file(s) one at
  a time. Do not run the full fan-out suite unless a focused failure requires
  it.

## Acceptance criteria

1. `search.reranker.model=dashscope:qwen3-vl-rerank` reuses the existing
   DashScope Workspace host/key and reaches the native rerank endpoint.
2. Regular text retrieval reranks normally; image-aware retrieval sends safe
   mixed text/image documents when a source asset is eligible.
3. Image-as-query search reranks with the incoming image and its returned
   text/image candidates.
4. Generic reranker providers and every failure path preserve existing
   behavior: no crash, no leaking paths/content, no silent source-scope
   expansion, and original retrieval order on failure.
5. Tests are hermetic, one-worker constrained, and no indexing or embedding
   job is started by verification.

## Execution receipt

- Red phase: the native DashScope and confined-source tests failed before the
  adapter and loader existed; existing generic reranker tests passed.
- Green verification: 82 focused tests (including the LLMS freshness test)
  passed with `GBRAIN_TEST_MAX_CONCURRENCY=1`; the legacy PGLite hybrid
  reranker integration passed separately against an isolated `GBRAIN_HOME`.
- Static and artifact checks: `bun run typecheck`, `bun run build:llms`, and
  `git diff --check` passed. All provider calls in tests were stubbed; no
  import, reindex, or embedding job ran.

## Plan engineering review

**Result:** approved with the fixed bounds and source-identity rule above.
`plan-eng-review` is not installed in this Codex workspace, so this is the
equivalent recorded engineering review requested for the plan.

| Area | Review finding | Decision |
|---|---|---|
| Native provider shape | The Workspace native rerank endpoint and payload differ from both the configured embedding endpoint and the existing generic rerank request. Treating it as a path override would produce an invalid body and parse the wrong response field. | Add one model-specific native adapter, tested independently; retain generic provider code unchanged. |
| Auth and URL routing | The user's existing DashScope Workspace host/key are correct inputs, but a rerank call must derive a sibling native path rather than append `/models/rerank` to the embedding base URL. | Reuse canonical recipe auth; derive only from native text-embedding or `/compatible-mode/v1` bases; reject all other bases before network I/O. |
| Source isolation and filesystem trust | `files.storage_path` is metadata, not a safe absolute path. Loading it directly would allow traversal, source mixing, and symlink escape. | Match the result and file source IDs, map only that source's registered root, require `isPathContained(asset, root)`, and fall back to chunk text on every failure. The existing operation scope resolver remains the sole authority for which results enter the set. |
| Remote behavior | A remote caller with source access may trigger reranking of that already-authorized source's image assets. This is outbound processing, not a new read grant, but it must not turn storage metadata into an unrestricted file read. | Permit only the confined, source-scoped path described above; unsupported storage-only assets are text fallbacks. Document that selected assets leave the deployment for DashScope processing. |
| Provider and resource bounds | Alibaba permits more images than is sensible on a search hot path. Loading 30 original 10 MiB assets would create excessive disk, CPU, memory, network, and billable work. | Sequentially consider at most four 1 MiB candidate images; use text for the rest. Retain the incoming query cap and enforce a 20 MiB serialized request guard. No worker or background-job fan-out is introduced. |
| Provider document limits | The model allows 100 text or 40 image documents. GBrain's normal `top_n_in=30` is inside both limits, but user overrides may not be. | Validate before HTTP and surface `payload_too_large`, which existing search converts to original-order fail-open. Existing chunking stays below the documented 8,000-token item ceiling in normal search; direct callers remain provider-limited. |
| Retrieval and cache invariants | The reranker runs after RRF/dedup and before token trimming. Reordering or truncating the tail would reduce recall. The existing cache key already includes the reranker model and knobs. | Keep the existing head-only reorder, tail preservation, score attribution, fail-open audit, and cache-key behavior. Do not add a new cache knob or migration. |
| Query shape | DashScope supports one query modality per request. `search_by_image` currently also accepts an optional text refinement. | Keep refinement in its existing RRF stage and use the image for reranking; do not invent an unsupported fused query payload. |
| Backward compatibility | Widening the generic rerank API risks sending image dictionaries to ZE/llama-compatible endpoints. | Permit rich content only in the DashScope Qwen branch; validate string-only inputs before all generic provider requests. Pin this in regression tests. |
| Verification isolation | Live provider calls would expose user content and are unnecessary to prove adapter correctness. Parallel suites previously caused avoidable load. | Stub the gateway transport/fetch, run focused files with `GBRAIN_TEST_MAX_CONCURRENCY=1`, and do not invoke import/reindex/backfill jobs. |

**Review follow-ups incorporated:** source ID matching, sequential candidate
loading, explicit provider-over-limit fail-open behavior, and documentation of
the remote outbound-data boundary are acceptance criteria, not deferred work.
