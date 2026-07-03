# Configurable query-embed deadline

- **Shipped:** 2026-07-03 (branch `franky`)
- **Status:** shipped
- **Scope:** search — hybrid query pipeline

## What changed

`query_embed_timeout_ms` is a new search-mode knob (default 6000ms in every
bundle) that caps how long the query-time embed may run before the vector leg
falls back to keyword-only. It is overridable per-key via the
`search.query_embed_timeout_ms` config key and per-process via the
`GBRAIN_QUERY_EMBED_TIMEOUT_MS` env var.

## Why

Semantic search embeds the query at call time under a deadline built for a
*stalled* provider. But a healthy-but-far provider — a cold DashScope Beijing
round trip from a fresh CLI process — routinely exceeds 6s, so the vector leg
silently dropped and `gbrain query` degraded to keyword-only. The symptom reads
as broken embeddings: paraphrase and CJK queries return "No results" while
exact-keyword queries work, even though embeddings are 100% present. Making the
deadline configurable fixes it without loosening the stalled-provider guard for
nearby providers.

## How to use

```bash
gbrain config set search.query_embed_timeout_ms 20000      # DB-plane search key
GBRAIN_QUERY_EMBED_TIMEOUT_MS=20000 gbrain query "..."      # env escape hatch (wins)
```

Precedence: env > per-call > config key > bundle default (6000). Cross-border
providers typically set 20000.

## Under the hood

- `src/core/search/mode.ts` — `query_embed_timeout_ms` in `ModeBundle`,
  `SearchKeyOverrides`, `SearchPerCallOpts`, `SEARCH_MODE_CONFIG_KEYS`,
  `loadOverridesFromConfig`, `resolveSearchMode`.
- `src/core/search/hybrid.ts` — `resolveQueryEmbedTimeoutMs(configuredMs?)`
  (env > configured > 6000); both `hybridSearch` and `hybridSearchCached` pass
  it into `makeQueryEmbedDeadline(...)`, so the cache-lookup embed and the
  vector-leg embed share one budget. On timeout `embedQueryBounded` throws and
  the catch falls back to keyword-only.
- KEY_FILES entries: `search/mode.ts`, `search/hybrid.ts`.
- Reference: [`../operations/search-modes.md`](../operations/search-modes.md)
  (knob bundle + "Query-embed timeout" section);
  [`../guides/search-modes.md`](../guides/search-modes.md) (troubleshooting).

## Tests

`test/search-mode.test.ts` — bundle default (6000 in all three modes), config-key
parse (`loadOverridesFromConfig`), malformed/non-positive fall-through, override
precedence, and `SEARCH_MODE_CONFIG_KEYS` registration.
