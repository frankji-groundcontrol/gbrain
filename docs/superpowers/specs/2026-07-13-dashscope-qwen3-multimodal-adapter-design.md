# DashScope Qwen3 Multimodal Adapter Design

**Date:** 2026-07-13  
**Status:** Approved for implementation planning

## Goal

Allow GBrain cross-modal retrieval to use Alibaba DashScope
`qwen3-vl-embedding` at 1024 dimensions, while retaining
`text-embedding-v4` as the normal text embedding model.

## Decision

Add a narrow native DashScope multimodal path. It reuses the existing
`dashscope` recipe, `DASHSCOPE_API_KEY`, and `provider_base_urls.dashscope`
configuration. When that base URL is the existing workspace-native text
endpoint, replace only its final service path with DashScope's documented
multimodal service path.

The adapter sends one DashScope `contents` element for each GBrain input and
returns one vector for each response item. Text becomes `{ text }`; image
bytes become a data URL in `{ image }`. It requests 1024 dimensions and
requires every returned vector to have that width before storage.

Qwen's optional fusion mode is deliberately out of scope. GBrain's current
multimodal API accepts independent text or image inputs and needs one vector
per input for batch reindexing. Enabling fusion would collapse a batch into a
different cardinality and corrupt that contract.

## Scope

- Register `qwen3-vl-embedding` as DashScope's sole multimodal model.
- Add a native request/response adapter for DashScope multimodal embeddings.
- Support text queries and base64 image queries/indexing at 1024 dimensions.
- Add hermetic request/response mapping tests.
- Document configuration and the supported capability.

## Out of Scope

- Replacing the primary `text-embedding-v4` model.
- Flash/Plus model support, video inputs, and Qwen fused text-plus-image
  objects.
- Schema changes: GBrain's existing multimodal columns are already
  `vector(1024)`.
- A LiteLLM proxy or additional provider configuration.

## Native API Contract

DashScope documents a native multimodal endpoint:

```text
/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding
```

The request uses bearer authentication and this shape:

```json
{
  "model": "qwen3-vl-embedding",
  "input": { "contents": [{ "text": "example" }] },
  "parameters": { "dimension": 1024 }
}
```

Images use a `data:<mime>;base64,<bytes>` value in an `image` object.
DashScope responds through `output.embeddings`, rather than the OpenAI
`data` array. The adapter maps those rows to `Float32Array` values in response
index order and rejects missing, non-array, wrong-count, or non-1024d rows.

Reference: <https://help.aliyun.com/zh/model-studio/multimodal-embedding-api-reference>

## Error Handling

- Missing key or a 401/403 becomes `AIConfigError` with the existing DashScope
  setup hint.
- Other non-success responses and malformed payloads become `AITransientError`.
- The existing 60-second multimodal timeout applies.
- Text-only embedding behavior and its workspace compatibility adapter remain
  unchanged.

## Verification

One hermetic unit test proves that a Workspace-native text endpoint is
rewritten to the native multimodal endpoint; it verifies the auth header,
1024d independent-input payload, and response-to-vector mapping. A second
assertion proves a non-1024d response fails before storage. Run the focused
test, the existing DashScope workspace regression test, and typecheck.
