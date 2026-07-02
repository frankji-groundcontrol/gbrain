# Architecture docs

One file per concern; this README is the soft index. These are living
reference docs: when source layout, workflows, or invariants change, update
the matching doc in the same change (current-state prose only — release
history belongs in `CHANGELOG.md` + git; `scripts/check-key-files-current-state.sh`
enforces this for the starred docs below).

## Living references

- [KEY_FILES.md](KEY_FILES.md) ★ — per-file index of `src/`: what each file
  does + its load-bearing invariants. Read a file's entry before editing it.
- [brains-and-sources.md](brains-and-sources.md) — the two axes: brain (which
  DB) vs source (which repo inside it), with the 6-tier resolution precedence.
- [topologies.md](topologies.md) — the three deployment topologies + decision
  tree.
- [RETRIEVAL.md](RETRIEVAL.md) — the full query pipeline: vector + BM25 + RRF +
  graph + reranker, source-aware ranking, intent routing.
- [system-of-record.md](system-of-record.md) — markdown repo is the system of
  record, DB a derived cache; forget semantics; rebuild recipe.
- [thin-client.md](thin-client.md) ★ — the thin-client / remote-MCP routing
  seam.
- [schema-packs.md](schema-packs.md) — schema packs: bundled packs, CLI verbs,
  the resolution chain, authoring.
- [type-taxonomy.md](type-taxonomy.md) — the canonical page-type taxonomy and
  the unify-types migration flow.
- [lens-packs.md](lens-packs.md) — the bundled lens packs (cycle phases,
  calibration domains).
- [pack-upgrade-mechanism.md](pack-upgrade-mechanism.md) — pack succession and
  the upgrade flow.
- [serve-sync-concurrency.md](serve-sync-concurrency.md) — PGLite single-writer
  contention between `serve` and large syncs.
- [infra-layer.md](infra-layer.md) — early system overview; op counts and the
  search-surface description lag the current system (see RETRIEVAL.md and
  `../ENGINES.md` for current truth).

## Point-in-time records

- [RETRIEVAL_MAXPOOL_INCIDENT.md](RETRIEVAL_MAXPOOL_INCIDENT.md) — postmortem
  of a named-page retrieval miss and its 4-layer fix.
- [calibration-quality-gate-spec.md](calibration-quality-gate-spec.md) —
  design spec for takes falsifiability filtering; partially shipped.
- [frontmatter-scan-incremental.md](frontmatter-scan-incremental.md) — design
  sketch for incremental frontmatter scan state; not yet built.

★ = current-state guard applies (`check-key-files-current-state.sh`).
