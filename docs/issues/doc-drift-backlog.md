# Doc drift backlog (2026-07-03 survey)

A full-tree documentation survey (every `docs/**/*.md`, plus router files and
repo structure) ran on 2026-07-03 as part of initializing the doc record
system ([plan record](../plans/2026-07-03-clean-repo-org-docs-init.md)). Fixed
in that pass: the misrouted search-modes reference-map row, stale skill/op
counts in router docs and `mcp/DEPLOY.md`/`ALTERNATIVES.md`, three broken
links, a duplicated paragraph, and a real-name privacy sweep. The items below
were surveyed but deferred — each is a self-contained follow-up.

## Deferred items

- **`skills/RESOLVER.md` carries a literal `## Uncategorized` section** holding
  ~12 skills (including `schema-author`, `schema-unify`) with full dispatcher
  clauses. Absorb them into functional areas per the
  `skills/functional-area-resolver/` pattern the repo itself ships.
- **`docs/ENGINES.md` interface listing is stale**: it shows ~40 engine methods
  while `src/core/engine.ts` has ~130, and its PGLite data path disagrees with
  other docs. The invariants (JSONB rule, parity discipline) are current; the
  snapshot sections need a current-state rewrite.
- **`docs/architecture/infra-layer.md`** is an early overview whose op counts
  and search-surface description duplicate `RETRIEVAL.md` less accurately.
  Either compress to a pointer or refresh.
- **`docs/UPGRADING_DOWNSTREAM_AGENTS.md`** promises a section per release but
  stops at v0.36.5.0. Decide: mark closed in favor of the skillpack
  scaffold/reference model, or resume maintenance.
- **`docs/GBRAIN_VERIFY.md`** cites numbered sections of
  `GBRAIN_SKILLPACK.md` that no longer exist (it is now a link-table index).
  Re-point the citations.
- **`docs/architecture/thin-client.md`** has drifted from a routing-seam doc
  toward KEY_FILES-style per-file entries; fold those entries back into
  `KEY_FILES.md` and restore the seam framing.
- **`docs/architecture/KEY_FILES.md`** contains two version-labeled cluster
  sections that sit in tension with its own no-release-narration rule;
  collapse them into per-file current truth.
- **`docs/issues/` + `docs/proposals/` shipped-status notes**: records describe
  as-missing behavior that has since shipped; add closing notes at the top of
  each (started for the two issue records via the README, not yet inside the
  files themselves).
- **`docs/tutorials/README.md`** lists five "in progress" tutorials that don't
  exist yet; either write them or mark them planned-not-started.
- **`docs/eval/SEARCH_MODE_METHODOLOGY.md`** referenced committed result dumps
  that were never committed (link fixed in the 2026-07-03 pass); decide whether
  to commit the NDJSON dumps or keep the pointer to the eval-results channel.
- **`docs/takes-vs-facts.md`** embeds a dated production-run report inside an
  otherwise living doc; split the report into a dated record.
- **`docs/guides/cron-schedule.md`** teaches raw crontab and predates the
  cron-via-minions convention (`skills/conventions/cron-via-minions.md`); align
  or cross-reference.
- **`docs/guides/idea-capture.md` vs `entity-detection.md`** duplicate the
  filing-rules table and notability filter nearly verbatim; extract the shared
  reference or cross-link one to the other.
- **`docs/guides/sub-agent-routing.md`** quotes dated model names and prices;
  refresh against `skills/conventions/model-routing.md`.
- **`docs/mcp/DEPLOY.md` Operations section** needs a fuller rewrite than the
  count fix applied in the survey pass: the remote-op story should be derived
  from `src/core/operations.ts` scopes rather than a hand-maintained list.

## Privacy-sweep items needing an owner decision

The 2026-07-03 sweep replaced real person/company names and private
identifiers in the survey-flagged docs. Three classes were deferred:

- **A downstream fork name appears in ~10 more docs** (INSTALL, GBRAIN_SKILLPACK,
  several guides, historical designs), including one doc that links a public
  GitHub repo for it — so it may be a public project rather than a private
  deployment. Decide whether the CLAUDE.md "your OpenClaw" phrasing applies,
  then sweep or whitelist consistently (extend `scripts/check-privacy.sh`
  either way so the decision is enforced).
- **`docs/guides/originals-folder.md`** teaches with vivid original-idea titles
  that appear to come from the author's real brain; the doc's pedagogical point
  ("the vividness IS the concept") depends on vivid examples. Either bless
  them or invent equally-vivid fictional ones.
- **Personal project names persist in `src/` comments** (`title-match.ts`,
  `hybrid.ts`, `migrate.ts`, `search-diagnose.ts`) and in the KEY_FILES entries
  quoting them. Comments in checked-in code are public artifacts per the
  privacy rule; sweep code + docs together in one small cleanup commit so the
  per-file index stays accurate.
