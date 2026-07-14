# Why the hybrid + graph stack works

Vector search alone underdelivers on real personal-knowledge queries. This doc explains why gbrain layers four strategies together and how they compound.

## The four strategies in concert

1. **Vector (HNSW on pgvector)** — semantic similarity. Catches "who works on retrieval quality at Acme?" → pages mentioning "Alice Chen + retrieval" even when the user never typed "Acme".
2. **BM25 keyword** — lexical match. Catches names, exact phrases, code identifiers, anything where the user remembers the literal token. Survives the cases where vector search drifts into thematic neighbors.
3. **Reciprocal-rank fusion (RRF)** — merges vector + keyword rankings without weighting one over the other globally. Each strategy gets to vote.
4. **Knowledge graph traversal** — follows typed edges. Catches "what did Bob invest in this quarter?" by walking `bob ── invested_in ──> company ── dated ──> Q1`. Vector search can't see causal chains; the graph can.

## Why each one alone fails

**Vector only.** Returns chunks semantically close to the query. Misses any factual relationship not directly encoded in the embedding. "Companies in Alice's portfolio" returns essays about portfolios, not company pages.

**Keyword only (ripgrep-style).** Brittle to phrasing. "Who works on retrieval?" misses pages that say "search ranking" instead of "retrieval." Garbage on synonyms, near-misses, or paraphrases.

**Graph only.** Excellent at "neighbors of Alice" but blind to anything not yet linked. Sparse on fresh pages until backlinks accumulate.

**Hybrid (vector + keyword + RRF), no graph.** Decent at "what is X?" type queries. Fails on "what is Y's relationship to X?" — those are graph queries and no amount of embedding tuning recovers them.

## The benchmark

BrainBench (corpus + harness in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo) measures retrieval P@5, R@5, MRR, nDCG@5 on a 240-page Opus-generated rich-prose corpus.

| Strategy | P@5 | R@5 | Notes |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | Lexical-only baseline |
| vector-only RAG | ~18 | ~80 | Standard RAG implementation |
| gbrain graph-disabled (hybrid + RRF, no graph traversal) | ~18 | ~85 | Hybrid alone |
| **gbrain default (full stack)** | **49.1** | **97.9** | Graph + extract-quality lift |

**+31 P@5 points** from the graph + extract quality work. The graph isn't a marginal feature; it's the load-bearing wall.

## Auto-link: why zero-LLM-call edge extraction works

Every `put_page` runs `extractEntityRefs` on the markdown body. It matches:

- Standard markdown links: `[Alice Chen](wiki/people/alice-chen)`
- Obsidian wikilinks: `[[wiki/people/alice-chen|Alice Chen]]`
- Typed-link blockquotes: `> **Convention:** see [path](path).`

Three regexes, zero LLM tokens, single SQL `addLinksBatch` call with `INSERT ... SELECT FROM jsonb_to_recordset(($1::jsonb)->'rows') JOIN pages ON CONFLICT DO NOTHING RETURNING 1` (free-text-safe; the prior `unnest(${arr}::text[])` form crashed on calendar/Zoom context per gbrain#1861). The graph grows on every write at near-zero cost. On a 17K-page brain, full graph extract completes in seconds.

Heuristic link-type inference (`attended`, `works_at`, `invested_in`, `founded`, `advises`) fires from surrounding sentence context — also LLM-free. Power users who want richer types add them via the typed-link blockquote convention.

## Cross-encoder reranking

The configured reranker re-scores the head of the retrieved candidate list
after hybrid + RRF + graph signals. A text-only provider such as ZeroEntropy's
`zerank-2` receives query text plus text chunks. DashScope's
`qwen3-vl-rerank` can additionally receive an image query or a bounded mix of
text and image candidates.

The mechanical reason: hybrid ranking is locally optimal per strategy but globally suboptimal. A cross-encoder reranker reads the query + each candidate document jointly, with full attention. It catches the cases where the vector + keyword + graph signals all agreed on a document that's semantically related but topically wrong.

Reranking is optional: disable it with `gbrain config set
search.reranker.enabled false`. Provider latency and billing apply only after
initial retrieval identifies candidates.

For DashScope multimodal reranking, GBrain reads at most four 1 MiB image
assets sequentially. An asset must be associated with the selected result's
source and remain inside that source's realpath-resolved `local_path`; every
missing, unsafe, unsupported, or over-cap asset remains a text candidate.
This preserves source isolation and bounds disk, CPU, network, and provider
work. The reranker remains fail-open: a candidate-resolution or provider error
returns the initial retrieval order.

## Source-aware ranking

Hybrid search applies a source-factor CASE expression at the SQL layer (lives in `src/core/search/sql-ranking.ts`). Curated content like `originals/`, `concepts/`, `writing/` outranks bulk content like `your-openclaw/chat/`, `daily/`, `media/x/`. Hard-exclude prefixes (`test/`, `attachments/`, `.raw/`) filter at retrieval, not post-rank.

`archive/` is deliberately NOT hard-excluded (issue #1777): it holds high-signal historical content users expect to find, so it is demoted (`0.5x` in `DEFAULT_SOURCE_BOOSTS`), not hidden. The demote is a prior applied in the outer SQL re-rank; the cross-encoder reranker (balanced/tokenmax modes) can still PROMOTE an archive page that survives the demote into the rerank candidate window — it is not an unconditional suppression. `gbrain doctor`'s `hidden_by_search_policy` check reports how many chunked pages remain hidden by the surviving exclude prefixes.

The boost map is configurable via `GBRAIN_SOURCE_BOOST` env var or per-call `SearchOpts.exclude_slug_prefixes`. Temporal queries (`detail: 'high'`) bypass the boost so chat pages re-surface for time-sensitive lookups.

## Named-thing retrieval (per-page pool + title + alias + evidence)

A brain organized around *chosen names* (Aurora Pavilion, Hall of Dawn) needs more than
embedding proximity. Four layers, added after the incident in
[`RETRIEVAL_MAXPOOL_INCIDENT.md`](./RETRIEVAL_MAXPOOL_INCIDENT.md):

- **Per-page max-pool** — `searchVector` (both engines) collapses chunk-grain
  candidates to the best chunk per page (`DISTINCT ON (slug)`) over the full
  candidate set before the user `LIMIT`, via the shared `buildBestPerPagePoolCte`
  in `sql-ranking.ts`. The vector side returns N distinct pages by best chunk,
  not N chunks that collapse to fewer pages downstream.
- **Title-phrase boost** — when the normalized query is a contiguous token-run
  inside `page.title` (or an exact full-title match), a floor-ratio-gated,
  bounded multiplier fires (`applyTitleBoost`, `search.title_boost` knob). A
  query that is a phrase from the title can't lose to a body chunk by luck.
- **Alias hop** — free-text `aliases:` frontmatter is projected into a
  `page_aliases` table (separate from the `slug_aliases` wikilink redirect) and
  consulted at query time: a full normalized-query match injects/boosts the
  canonical page (`applyAliasHop`). The only layer that bridges true synonyms
  with zero surface overlap ("Hall of Dawn" → the Aurora Pavilion page). Backfill
  existing pages with `gbrain reindex --aliases`.
- **Evidence contract** — every result carries `evidence`
  (`alias_hit | exact_title_match | high_vector_match | keyword_exact |
  weak_semantic`) and `create_safety` (`exists | probable | unknown`). An agent
  deciding "is this page already here, safe to NOT write a duplicate?" keys off
  `create_safety`, not a raw blended score.

The `search` MCP/CLI op is **cheap-hybrid** (vector + keyword + RRF + pool +
title + alias, expansion off); `query` is the full-control variant. NamedThingBench
(`gbrain eval retrieval-quality`) gates these families on every PR. Diagnose a
specific miss with `gbrain search diagnose "<q>" --target <slug>`.

## Intent-aware query rewriting

`src/core/search/intent.ts` classifies queries into `entity`, `temporal`, `event`, or `general`. Each routes through different ranking knobs:

- **Entity** queries ("who works at X?") apply a higher graph-traversal weight.
- **Temporal** queries ("what happened last week?") bypass source-boost so chat/daily pages surface.
- **Event** queries ("Acme AI Series A") engage the timeline index.
- **General** queries hit the standard hybrid stack.

The classifier is deterministic (no LLM call). Wrong classification degrades gracefully — the hybrid stack still works without it.

## Multi-query expansion

For `detail: 'high'` searches, `src/core/search/expansion.ts` runs a Haiku-class LLM call to produce 2-3 query variants. Each variant runs through the full hybrid stack; results merge via RRF. Catches synonym misses without recall loss.

Expansion is opt-in per mode bundle (`tokenmax` on by default; `balanced` + `conservative` off). Default off in the cheap tiers because the LLM call adds ~$0.001/query and ~200ms — real money at scale.

## Putting it together

The full pipeline for a `query` op:

```
intent classify
       │
       ▼
expansion (if enabled)
       │
       ▼
hybrid search:
   ├── vector  (HNSW on chunk embeddings)
   ├── keyword (BM25 via tsvector)
   ├── relational (v0.42.34.0: typed-edge recall arm — relational queries only)
   ├── source-aware re-rank (CASE in SQL)
   └── RRF fusion → top 30
       │
       ▼
graph augment (typed-edge traversal from any seed)
       │
       ▼
reranker (configured cross-encoder, top-N head → reordered)
       │
       ▼
token-budget enforcement (per mode bundle)
       │
       ▼
deduplication (same slug, different chunks → keep best)
       │
       ▼
results
```

Each stage is testable in isolation. Each stage is replaceable. The whole pipeline is < 1ms of orchestration cost; the latency budget goes to the upstream HTTP calls (embedding, rerank) and the index scans.

The query-time embed sits on the critical path before the vector arm can run, so it is bounded by a wall-clock deadline (`search.query_embed_timeout_ms`, default 6000ms). If that budget elapses — common when the embedding provider is far from the caller (e.g. DashScope Beijing from a cold CLI process) — the vector arm is dropped and `query` degrades to keyword-only instead of blocking. Tuning lives in [docs/operations/search-modes.md](../operations/search-modes.md).

## How to verify on your own brain

```bash
# Run the public LongMemEval benchmark
gbrain eval longmemeval datasets/longmemeval_s.jsonl

# Capture your own queries and replay against retrieval changes
export GBRAIN_CONTRIBUTOR_MODE=1
# ... use gbrain normally ...
gbrain eval export > before.ndjson
# ... change something ...
gbrain eval replay --against before.ndjson

# A/B retrieval strategies on a labeled fixture
gbrain eval --qrels labels.tsv --config balanced.json
```

Methodology + metric glossary in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md).
