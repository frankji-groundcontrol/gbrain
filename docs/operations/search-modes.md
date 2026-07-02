# Named search modes (conservative / balanced / tokenmax)

GBrain ships three named search modes that bundle the search cost/quality knobs
into a single config key, `search.mode`. Pick one at install time (`gbrain init`
runs the picker after `engine.initSchema()`; non-TTY auto-selects); the rest of
the project resolves through `src/core/search/mode.ts`. Existing installs see a
one-time upgrade banner via `runPostUpgrade` in `src/commands/upgrade.ts`, gated
by `search.mode_upgrade_notice_shown`.

> Different topic, similar name: [docs/guides/search-modes.md](../guides/search-modes.md)
> teaches agents which search *command* to use (`search` vs `query` vs `get`).
> This doc covers the named mode *bundles* and their cost knobs.

## The knob bundles

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `relationalRetrieval`         | false          | **true**   | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

## Cost anchors

Downstream agent *input* cost dominates — gbrain itself is rounding error. The
corner-to-corner spread is 25x once you pair mode with downstream model. Chunks
~400 tokens avg. Per-query cost @ 10K queries/month (typical single-user
volume), full search payload, no cache savings:

| Mode \ Downstream | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage). Natural pairings span ~4x.
Mismatches (tokenmax+Haiku, conservative+Opus) waste capacity differently — a
too-big payload overwhelms a cheap model; a too-small payload starves an
expensive one.

tokenmax adds ~\$1.50 per 1K queries in Haiku expansion calls on top of the
matrix (\$15/mo @ 10K). Cache hits cut all numbers ~50%.

**Update in lockstep.** The cost picker copy in `gbrain init`
(`src/commands/init-mode-picker.ts`) carries the same matrix verbatim, and
`test/init-mode-picker.test.ts` pins its anchor cells. Refreshing any number
means updating this doc, the picker copy, and
[docs/eval/SEARCH_MODE_METHODOLOGY.md](../eval/SEARCH_MODE_METHODOLOGY.md)
together.

## Per-query math vs real-world spend

The matrix above is what an isolated benchmark would measure. Real agent loops
with disciplined Anthropic prompt caching see a 50-80% discount on top (cache
hits skip downstream entirely). The realistic-scale anchor in
[docs/eval/SEARCH_MODE_METHODOLOGY.md](../eval/SEARCH_MODE_METHODOLOGY.md)
walks the natural pairings at single-power-user volume (~860 turns/mo):
tokenmax+Opus ~\$700/mo, balanced+Sonnet ~\$430/mo, conservative+Haiku
~\$170/mo. Setups WITHOUT cache-aware prompt layout (frequent prefix churn) see
the per-query matrix dominate — mode + model choice matters more there.

`spend.posture` is deliberately separate from `search.mode=tokenmax`: mode
governs retrieval payload size; posture governs whether cost gates block. See
[docs/operations/spend-controls.md](spend-controls.md).

## Resolution chain

Matches the model-tier pattern at `src/core/model-config.ts:resolveModel`:

    per-call SearchOpts → per-key config (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in **bare `hybridSearch`** (NOT just the cached wrapper)
so `gbrain eval replay` and `gbrain eval longmemeval` exercise the same
mode-affected behavior as the production `query` op.

## Cache-key hygiene (`knobs_hash`)

The `query_cache` lookup filter is
`WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $`. The hash
folds every result-shaping knob into the cache key: the mode bundle's knobs,
the active embedding column name + provider (so a query routed through a
1024d Voyage column can't be served a row written against the 1536d OpenAI
column), and the `relationalRetrieval` flag + depth. Whenever a new knob starts
shaping results, fold it into the hash and bump
`mode.ts:KNOBS_HASH_VERSION` (the single source of truth); existing rows become
unreachable on first re-query, which shows up as a one-time miss spike on
upgrade.

## Relational retrieval

`relationalRetrieval` (on for balanced/tokenmax) adds a fourth recall arm: a
relational query ("who invested in X", "what connects A and B") resolves its
seed entity and walks the typed-edge graph
(`src/core/search/relational-recall.ts` + `relational-intent.ts`,
`engine.relationalFanout`), injecting edge-derived answers into RRF.
Within-source, deterministic, mentions-excluded by default, and a pure no-op
for non-relational queries. The `query` op's `relational` flag forces it on/off
per call.

## CLI surfaces

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

## Related

- [docs/architecture/RETRIEVAL.md](../architecture/RETRIEVAL.md) — the full
  retrieval pipeline these knobs act on.
- [docs/eval/SEARCH_MODE_METHODOLOGY.md](../eval/SEARCH_MODE_METHODOLOGY.md) —
  how mode claims are measured.
- [docs/operations/spend-controls.md](spend-controls.md) — cost gates and
  `spend.posture`.
- [docs/guides/search-modes.md](../guides/search-modes.md) — which search
  command to use (agent-facing, different topic).
- [skills/conventions/search-modes.md](../../skills/conventions/search-modes.md)
  — the agent-facing convention for behaving under the active mode.
