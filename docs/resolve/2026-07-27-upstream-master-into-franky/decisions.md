# Per-file decisions (2026-07-27 sync)

Companion to [README.md](README.md). One entry per conflicted file.

## The finding that settled three files at once

`DEDICATED_EXTENSION_PLACEMENT` puts `vector` in `extensions` and `pg_trgm` in
`public`, while `DEDICATED_SEARCH_PATH` is `groundcontrol,extensions`.
**`public` is not on the search path.** Two consequences, both non-obvious:

1. Every trigram call must be schema-qualified (`public.similarity`,
   `public.word_similarity`, `OPERATOR(public.%)`, `OPERATOR(public.<%)`) or it
   fails to resolve in dedicated mode. The fork's qualification is load-bearing,
   not cosmetic.
2. `update_page_search_vector()` references `timeline_entries` unqualified, and
   that table lives in `groundcontrol` under dedicated mode. A literal
   `SET search_path = pg_catalog, public` breaks every page write.

This decided `src/schema.sql` and both `src/core/postgres-engine.ts` hunks.

---

## Pure unions

| File | Union |
|---|---|
| `src/core/ai/build-gateway-config.ts` | fork's `dashscope_api_key` + upstream's `openrouter_api_key` / `voyage_api_key` |
| `src/core/embedding-pricing.ts` | both price tables |
| `src/core/ai/types.ts` | merged doc comment covering both the DashScope 10-item and llama-server batch-size rationales |

### `src/core/ai/dims.ts` — union with glue

Naive union would have produced invalid syntax. HEAD's side ended mid-function:
`isValidDashScopeV4Dim`'s closing brace sat in the shared context *after* the
conflict, and that same brace closed upstream's last function. Resolved with an
explicit `'}\n\n'` glue string between the two sides. Carries DashScope +
Perplexity + NVIDIA blocks.

### `src/core/config.ts` — 2 hunks, union with glue

Same trap: hunk 1 split mid-doc-comment, needing `'  /**\n'` as glue. The merged
interface carries `dashscope_api_key`, `direct_database_url`,
`postgres_schema?: 'groundcontrol'`, `openrouter_api_key`, `voyage_api_key`.

**Lesson from both:** a union is only safe after reading the shared context
lines immediately before `<<<<<<<` and after `>>>>>>>`. A conflict boundary
falls wherever the diff algorithm put it, not on a syntactic boundary.

---

## Judgment calls

### `src/core/ai/gateway.ts` — union, then upstream

Hunk 1 union. Hunk 2 takes upstream's `capBatchItems` form: its
`maxBatchItems`-only gate is a strict superset of HEAD's
`maxBatchTokens && maxBatchItems`, so the DashScope item cap still fires and
upstream additionally caps when no token budget is set.

### `src/commands/providers.ts` — upstream, both hunks

Upstream's `baseGatewayConfig = cfg ? buildGatewayConfig(cfg) : {...}` forwards
config-plane API keys (including `dashscope_api_key`) *plus* base URLs. The
fork's `buildProbeGatewayConfig` forwarded only base URLs and env, so upstream's
form is strictly better for DashScope probing. Side effect recorded as a
follow-up in README.md.

### `src/commands/migrate-engine.ts` — upstream structure, fork field nested

Took upstream's `#3194` gate (only flip the active config when
`failures.length === 0`) plus its `clearManifest()` call, with the fork's
`postgres_schema` persistence nested inside the postgres branch. Verified
`clearManifest` is defined once and called only here, and that the following
`if (failures.length > 0)` block already prints "Config NOT switched" — the two
are coherent, not redundant. The fork's `direct_database_url` threading survives
elsewhere in the file and was untouched.

### `src/core/connection-manager.ts` — composed

Upstream's `normalizeDirectUrl(opts.url, opts.directUrl ?? envOverride)`
subsumes HEAD's raw `override ?? derive` chain (it re-derives internally and
normalizes pooler-shaped overrides), so upstream's call replaces the fork's.
The fork's dedicated-mode defensive re-normalization is kept *after* it, so a
library caller constructing a `ConnectionManager` directly still fails closed on
a conflicting search path.

### `src/core/import-file.ts` — upstream structure, fork logic inside

Upstream added `sourceOpts` threading to `getPage` / `getChunks`. Per the
CLAUDE.md source-isolation invariant ("a missed thread is a cross-source data
leak") this is not optional, so upstream's structure wins; the fork's
multimodal-embedding freshness check (`hasCurrentUnifiedEmbedding`) is composed
inside it. Confirmed against the signature: `getChunks(slug, opts?: { sourceId?: string })`.

### `src/schema.sql` — fork's `FROM CURRENT`, upstream's comment

Kept `SET search_path FROM CURRENT` (see the finding above), took upstream's
`#2704` rationale comment, and **added a note explaining why `FROM CURRENT`
stays** so the next sync doesn't "correct" it back to the literal path. That
note is the actual deliverable here — the code was already right; what was
missing was the reason.

`scripts/check-search-path.sh` passes, so the fork's form still satisfies the
guard upstream added.

---

## Docs

### `README.md` — both, in order

Upstream's "Non-English brains (FTS language config)" block, then the fork's
skills-count paragraph.

**Near-miss worth recording:** the first resolution dropped the skills
paragraph entirely, because HEAD's whole side *was* that paragraph and the
replacement string only contained upstream's block. Zero conflict markers, and
still wrong. Caught by grepping for a phrase that should have survived.

> Verifying "no markers remain" is not verifying the resolution. Check that
> every semantic element from *both* sides is still present.

The fork's count (52, matching `skills/manifest.json`) is kept over upstream's
stale 43.

### `docs/architecture/KEY_FILES.md` — six entries composed

| Entry | Resolution |
|---|---|
| `utils.ts` | upstream (adds `rowToSearchResult` email `message_id`/`thread_id` projection) |
| `db.ts` | upstream + fork's `normalizeDedicatedPostgresConfig()` sentence |
| `postgres-dedicated.ts` | fork + **new** sentence: `ConnectionManager` now resolves the direct URL through `normalizeDirectUrl()` before the dedicated normalizer |
| dedicated behavior in `postgres-engine.ts` | fork + **new** sentence on `DEDICATED_EXTENSION_PLACEMENT` forcing `public.`-qualified trigram calls |
| `config.ts` | fork |
| `migrate-engine.ts` | upstream's rewrite (`copyMigrationSources`, target-aware manifest) + the `#3194` gate clause + the fork's `direct_database_url` threading |

The two **new** sentences are the ones a future reader needs: both document a
coupling this merge created, which neither side's doc described because neither
side had both halves.
