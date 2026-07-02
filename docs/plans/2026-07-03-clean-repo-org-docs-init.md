---
title: "docs: init modular doc record system + thin-router pass over CLAUDE.md and AGENTS.md"
type: docs
status: completed
date: 2026-07-03
---

# docs: init modular doc record system + thin-router pass

## Goal

Initialize the modular documentation record system for this repo (per the
clean-repo-org workflow): a top-level documentation map, soft indexes for the
record aspects (architecture, learning, plans, practices, issues), and a
docs-maintenance reminder in both router files (`CLAUDE.md`, `AGENTS.md`) so
future changes keep routers thin and records current.

## Scope decisions

- **Indexes, not file moves.** `docs/` already has a working folder taxonomy
  and hundreds of inbound links (CLAUDE.md reference map, skills, llms bundles,
  CI guards). This pass adds navigation and record scaffolding; it does not
  relocate existing docs. Flagged-stale docs are annotated in the map, not moved.
- **IRON RULES stay inline in CLAUDE.md.** CLAUDE.md's own maintenance section
  mandates this; the router pass adds links, it does not relocate ship rules.
- **llms bundles are generated.** Any CLAUDE.md or registered-doc change
  requires `bun run build:llms` in the same change (CI freshness test).

## Checklist

- [x] Plan record opened (this file)
- [x] `docs/plans/README.md` — plans index created (this plan + 2026-06-03 plan)
- [x] Deep-read survey of every `docs/**/*.md` + repo structure (workflow fan-out)
- [x] `docs/README.md` — full documentation map composed from the survey
- [x] `docs/architecture/README.md` — architecture soft index
- [x] `docs/learning/README.md` — learning records area initialized
- [x] `docs/practices/README.md` — practices records area initialized
- [x] `docs/issues/README.md` — issue records index
- [x] `docs/operations/search-modes.md` — named mode bundles doc (extracted from
      CLAUDE.md `## Search Mode`; fixes the reference-map row that misroutes
      "search modes / cost knobs" to the command-selection guide)
- [x] `docs/operations/pace-mode.md` — extracted from CLAUDE.md `## Pace Mode`
- [x] `docs/operations/sync-tuning.md` — extracted from CLAUDE.md `## Sync resumability`
- [x] `docs/progress-events.md` — absorb the bulk-command wiring how-to from
      CLAUDE.md `## Bulk-action progress reporting`
- [x] `CLAUDE.md` — compress extracted sections to summaries + links; add
      docs-maintenance reminder + reference-map rows (doc map, records)
- [x] `test/init-mode-picker.test.ts` — update lockstep comments to cite the new
      search-modes doc location
- [x] Privacy sweep — replace real person/company names and private identifiers
      in flagged docs with standard placeholders (`alice-example`,
      `acme-example`, `your OpenClaw`), per the CLAUDE.md privacy rule
- [x] Drift fixes from survey — skill-count claims (CLAUDE.md / README.md),
      `docs/mcp/DEPLOY.md` + `ALTERNATIVES.md` stale op counts, three broken
      links (brains-and-sources, SEARCH_MODE_METHODOLOGY, ENGINES), duplicated
      paragraph in `docs/integrations/embedding-providers.md`
- [x] `docs/issues/doc-drift-backlog.md` — record surveyed-but-deferred drift
      (stale overviews, unabsorbed resolver entries) for follow-up
- [x] `AGENTS.md` — docs-maintenance reminder + doc-map link in read order
- [x] `scripts/llms-config.ts` — register `docs/README.md`
- [x] `bun run build:llms` — bundles regenerated
- [x] Verification: `test/build-llms.test.ts`, `check-key-files-current-state.sh`,
      link resolution for every new/edited link, privacy scan of new records
- [x] Plan record closed (status: completed)

## Privacy risk

Low. This change writes navigation/index docs only, composed from already-public
repo content. New records must be scanned for real names, private identifiers,
and runtime paths before completion; examples use the repo's standard
placeholders (`alice-example`, `acme-example`, `fund-a`).

## Outcome

Completed 2026-07-03. All checklist items done; verification green
(`bun run build:llms` fresh, `test/build-llms.test.ts` +
`test/init-mode-picker.test.ts` 36/36, `check-key-files-current-state.sh`,
`check-privacy.sh`, `tsc --noEmit`, relative-link check over all 45 touched
markdown files). CLAUDE.md shrank 47.7KB -> ~38KB (cap 60KB) with all
content-contract strings preserved. A first learning record was filed
([reference-map filename collisions](../learning/2026-07-03-reference-map-filename-collisions.md));
surveyed-but-deferred drift lives in
[the doc-drift backlog](../issues/doc-drift-backlog.md).
