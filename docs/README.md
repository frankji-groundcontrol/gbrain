# GBrain documentation map

Every doc in this tree, one line each. The routing model is two-layer:
[`CLAUDE.md`](../CLAUDE.md) (Claude Code) and [`AGENTS.md`](../AGENTS.md)
(everyone else) are thin, always-loaded routers; this map and the folder
READMEs are the on-demand index; the docs carry the detail. Generated
companions: [`llms.txt`](../llms.txt) (URL-based map for agents fetching over
HTTP) and [`llms-full.txt`](../llms-full.txt) (core docs inlined) — regenerate
with `bun run build:llms`, never edit by hand.

Reference docs describe **current behavior only** — release history lives in
[`CHANGELOG.md`](../CHANGELOG.md) and git. Docs marked *(historical)* or
*(dated report)* below are deliberate point-in-time records; read them for
background, not current truth.

## Start here

- [INSTALL.md](INSTALL.md) — three install paths (agent platform, standalone
  CLI, MCP server), thin-client mode, API keys, verification.
- [GBRAIN_VERIFY.md](GBRAIN_VERIFY.md) — post-install verification runbook.
- [tutorials/](tutorials/README.md) — hands-on walkthroughs: personal brain,
  company brain, coding-agent memory, skillopt.
- [../INSTALL_FOR_AGENTS.md](../INSTALL_FOR_AGENTS.md) — the 9-step
  agent-executed install protocol.

## Architecture

Soft index: [architecture/README.md](architecture/README.md). Highlights:

- [architecture/KEY_FILES.md](architecture/KEY_FILES.md) — per-file index of
  `src/`: what each file does plus its load-bearing invariants. Read a file's
  entry before editing that file.
- [architecture/brains-and-sources.md](architecture/brains-and-sources.md) —
  the two-axis mental model (brain = which DB, source = which repo inside it).
- [architecture/RETRIEVAL.md](architecture/RETRIEVAL.md) — why retrieval layers
  vector + BM25 + RRF + graph + reranker; the full query pipeline.
- [architecture/system-of-record.md](architecture/system-of-record.md) — the
  markdown repo is the system of record; the DB is a derived cache.
- [architecture/thin-client.md](architecture/thin-client.md) — remote-MCP
  routing seam.
- [architecture/schema-packs.md](architecture/schema-packs.md),
  [architecture/type-taxonomy.md](architecture/type-taxonomy.md),
  [architecture/lens-packs.md](architecture/lens-packs.md),
  [architecture/pack-upgrade-mechanism.md](architecture/pack-upgrade-mechanism.md)
  — the schema-pack system.
- [architecture/topologies.md](architecture/topologies.md) — the three
  deployment topologies with a decision tree.
- [ENGINES.md](ENGINES.md) — pluggable engine architecture, PGLite vs
  Postgres, the JSONB double-encode rule. (Interface listing lags the current
  `src/core/engine.ts`; the invariants are current.)

## Operating a brain (guides/)

Agent operating protocols (the GBrain Skillpack family, indexed by
[GBRAIN_SKILLPACK.md](GBRAIN_SKILLPACK.md)) plus operator/deployment guides:

- Agent protocols: [brain-agent-loop](guides/brain-agent-loop.md),
  [brain-first-lookup](guides/brain-first-lookup.md),
  [brain-vs-memory](guides/brain-vs-memory.md),
  [compiled-truth](guides/compiled-truth.md),
  [entity-detection](guides/entity-detection.md),
  [operational-disciplines](guides/operational-disciplines.md),
  [source-attribution](guides/source-attribution.md),
  [originals-folder](guides/originals-folder.md) /
  [idea-capture](guides/idea-capture.md),
  [search-modes](guides/search-modes.md) (which search *command* to use — the
  named mode bundles live in [operations/search-modes.md](operations/search-modes.md)),
  [repo-architecture](guides/repo-architecture.md),
  [quiet-hours](guides/quiet-hours.md),
  [sub-agent-routing](guides/sub-agent-routing.md),
  [skill-development](guides/skill-development.md).
- Ingestion: [meeting-ingestion](guides/meeting-ingestion.md),
  [content-media](guides/content-media.md),
  [diligence-ingestion](guides/diligence-ingestion.md),
  [enrichment-pipeline](guides/enrichment-pipeline.md),
  [deterministic-collectors](guides/deterministic-collectors.md),
  [executive-assistant](guides/executive-assistant.md),
  [cron-schedule](guides/cron-schedule.md).
- Operations & deployment: [live-sync](guides/live-sync.md),
  [custom-schema-deployment](guides/custom-schema-deployment.md) (run the
  brain in a dedicated Postgres schema; Supabase search_path + IPv6 notes),
  [multi-source-brains](guides/multi-source-brains.md),
  [minions-deployment](guides/minions-deployment.md),
  [minions-shell-jobs](guides/minions-shell-jobs.md),
  [queue-operations-runbook](guides/queue-operations-runbook.md),
  [agent-to-gbrain](guides/agent-to-gbrain.md),
  [push-context](guides/push-context.md),
  [rls-and-you](guides/rls-and-you.md),
  [upgrades-auto-update](guides/upgrades-auto-update.md),
  [storage-tiering](storage-tiering.md),
  [minions-fix](guides/minions-fix.md) *(only for pre-v0.11.1 installs)*.
- Skills & skillpacks: [scaling-skills](guides/scaling-skills.md),
  [skillopt](guides/skillopt.md),
  [skillpacks-as-scaffolding](guides/skillpacks-as-scaffolding.md),
  [skillpack-anatomy](skillpack-anatomy.md),
  [plugin-authors](guides/plugin-authors.md),
  [plugin-handlers](guides/plugin-handlers.md).

## Cost & tuning (operations/)

- [operations/search-modes.md](operations/search-modes.md) — the named search
  mode bundles (conservative / balanced / tokenmax): knobs, cost matrix,
  resolution chain, cache-key hygiene.
- [operations/spend-controls.md](operations/spend-controls.md) — every
  embedding-spend gate, defaults, off switches, `spend.posture`.
- [operations/pace-mode.md](operations/pace-mode.md) — DB-contention-aware
  backfill pacing.
- [operations/sync-tuning.md](operations/sync-tuning.md) — sync checkpoints +
  lock-tuning env knobs.
- [operations/headless-install.md](operations/headless-install.md) — Docker/CI
  init patterns for fail-loud no-key behavior.

## Connecting clients (mcp/)

[mcp/DEPLOY.md](mcp/DEPLOY.md) is the hub (stdio vs OAuth HTTP vs bearer,
scopes, admin dashboard); per-client recipes:
[CLAUDE_CODE](mcp/CLAUDE_CODE.md), [CLAUDE_DESKTOP](mcp/CLAUDE_DESKTOP.md),
[CLAUDE_COWORK](mcp/CLAUDE_COWORK.md), [CHATGPT](mcp/CHATGPT.md),
[CODEX](mcp/CODEX.md), [PERPLEXITY](mcp/PERPLEXITY.md);
[ALTERNATIVES.md](mcp/ALTERNATIVES.md) compares tunnel/hosting options.

## Integrations & providers

- [integrations/](integrations/README.md) — data-ingestion integrations index:
  self-installing recipes, credential gateway, meeting webhooks, pre-commit
  frontmatter gate, embedding-provider registry.
- [ai-providers/zeroentropy.md](ai-providers/zeroentropy.md),
  [ai-providers/dashscope.md](ai-providers/dashscope.md),
  [ai-providers/llama-server-reranker.md](ai-providers/llama-server-reranker.md)
  — provider-specific embedding/reranker setup.
- [embedding-migrations.md](embedding-migrations.md) — switching embedding
  model/dimensions on an existing brain.
- [guardrails.md](guardrails.md) — observe-only guardrail seams for external
  classifiers.

## Knowledge model

- [takes-vs-facts.md](takes-vs-facts.md) — why takes (cold, multi-holder) and
  facts (hot, owner memory) are separate layers.
- [contradictions.md](contradictions.md) — the suspected-contradictions probe.
- [what-schemas-unlock.md](what-schemas-unlock.md) — the WHY of schema packs
  (read before the tutorial); [schema-author-tutorial.md](schema-author-tutorial.md)
  — the HOW (5-minute custom page type walkthrough);
  [GBRAIN_RECOMMENDED_SCHEMA.md](GBRAIN_RECOMMENDED_SCHEMA.md) — reference
  system prompt for an LLM-maintained brain repo.

## Contributing & releasing

- [TESTING.md](TESTING.md) — test tiers, isolation lint, E2E lifecycle.
- [RELEASING.md](RELEASING.md) — the full release + contributor process.
- [../CONTRIBUTING.md](../CONTRIBUTING.md), [../SECURITY.md](../SECURITY.md),
  [../DESIGN.md](../DESIGN.md) (design-system source of truth for the admin UI).
- [progress-events.md](progress-events.md) — the JSONL progress stream schema
  + wiring a new bulk command.
- [eval-bench.md](eval-bench.md) — maintainer dev loop for retrieval changes;
  [eval-capture.md](eval-capture.md) — NDJSON capture wire format;
  [eval-takes-quality.md](eval-takes-quality.md) — takes-quality eval contract;
  [eval/SEARCH_MODE_METHODOLOGY.md](eval/SEARCH_MODE_METHODOLOGY.md) —
  benchmark methodology; [eval/METRIC_GLOSSARY.md](eval/METRIC_GLOSSARY.md) —
  auto-generated metric definitions (CI-guarded).
- [UPGRADING_DOWNSTREAM_AGENTS.md](UPGRADING_DOWNSTREAM_AGENTS.md) — hand-apply
  diffs for forks with copied skill files *(covers through v0.36.5.0; the
  skillpack scaffold/reference model has since replaced hand-copying)*.

## Records (dated, point-in-time)

These folders are the durable record system. Each has a README index; records
are added, not rewritten.

- [plans/](plans/README.md) — dated task-plan records; open one at the start
  of multi-step work and drive the task from its checklist.
- [learning/](learning/README.md) — reusable lessons, decision rules, and
  failure modes distilled from completed work.
- [practices/](practices/README.md) — reusable setups, command sequences, and
  operational methods.
- [issues/](issues/README.md) — concrete implementation-issue records and
  improvement backlogs.
- [incidents/](incidents/2026-05-20-lsd-cost-explosion.md) — post-mortems
  (currently one: the lsd/brainstorm cost-overrun incident).
- [proposals/](proposals/temporal-contradiction-probe.md) — RFCs (currently
  one: the temporal contradiction probe, since largely shipped as
  `find_trajectory` + founder scorecard).
- [designs/](designs/) *(historical)* — design specs and CEO plans for work
  that has since shipped (code cathedral, integrations, minions orchestration,
  knowledge runtime, v0.38 schema packs, skillpack registry). Current truth
  lives in `architecture/` and `guides/`;
  [designs/COMMUNITY_IDEAS.md](designs/COMMUNITY_IDEAS.md) is the one living
  ledger (community-PR-wave ideas).
- [migrations/](migrations/v0.41.2-markdown-greenfield.md) — version-pinned
  migration runbooks (historical by design).
- [v0.38-smoke-test-report.md](v0.38-smoke-test-report.md) *(dated report)* —
  production smoke test of v0.38.0.0; findings addressed in v0.39.3.0.
- [GBRAIN_V0.md](GBRAIN_V0.md) *(historical)* — the original v0 design spec,
  explicitly superseded.

## Ethos

The three-piece philosophy arc:
[ethos/THIN_HARNESS_FAT_SKILLS.md](ethos/THIN_HARNESS_FAT_SKILLS.md) →
[ethos/MARKDOWN_SKILLS_AS_RECIPES.md](ethos/MARKDOWN_SKILLS_AS_RECIPES.md) →
[ethos/ORIGIN.md](ethos/ORIGIN.md). The companion design doc
[designs/HOMEBREW_FOR_PERSONAL_AI.md](designs/HOMEBREW_FOR_PERSONAL_AI.md)
*(historical)* is the what to the recipes essay's why.

## Maintaining this map

- Adding a doc? Add it to the right section here, to the folder README if the
  folder has one, and to `scripts/llms-config.ts` if agents should discover it
  over HTTP (then `bun run build:llms`).
- Write current-state prose; date-stamp anything that is a point-in-time
  record and file it under a records folder.
- Scrub real people, companies, funds, and private identifiers to placeholders
  (`alice-example`, `acme-example`, `fund-a`, `your OpenClaw`) — see the
  Privacy rule in [`CLAUDE.md`](../CLAUDE.md).
