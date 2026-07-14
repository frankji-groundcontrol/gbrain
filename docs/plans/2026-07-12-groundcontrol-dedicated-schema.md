---
title: "feat: dedicated groundcontrol Postgres schema mode"
type: feature
status: completed
date: 2026-07-12
---

# feat: dedicated groundcontrol Postgres schema mode

## Goal

Add an explicit `postgres_schema: "groundcontrol"` mode so the restricted
`groundcontrol_app` role owns, initializes, migrates, and uses only the
`groundcontrol` schema on Supabase region `aws-1-ap-southeast-1`, while every
legacy Postgres, URL-suffix custom-schema, and PGLite installation keeps its
current behavior byte-for-behavior.

## References

- Approved design: `docs/superpowers/specs/2026-07-12-groundcontrol-dedicated-schema-design.md`
- Task detail (implementation plan): `docs/superpowers/plans/2026-07-12-groundcontrol-dedicated-schema.md`

## Dependency graph

Task 1 → (2, 3); 3 → 4; 4 → 5A; 5A → (5B, 6); (2, 3, 5B, 6) → 7; 7 → 8; 8 → 9.
Task 0 is the docs-record scaffolding (this file).

## Checklist

- [x] Plan record opened (this file) + indexed in `docs/plans/README.md`
- [x] Task 1: fixed config + URL normalization (`src/core/postgres-dedicated.ts`)
- [x] Task 2: preserve resolved `EngineConfig` across host/worker/reconnect
- [x] Task 3: preflight every distinct pool before DDL
- [x] Task 4: dedicated bootstrap rendering + trigram qualification
- [x] Task 5A: select dedicated migration variants (no history rewrite)
- [x] Task 5B: namespace-scope catalog probes + retrieval planner
- [x] Task 6: verify before version advancement (compatibility-classified)
- [x] Task 7: gate init/migrate-engine persistence on full dedicated verification
- [x] Task 8: real-Postgres lifecycle E2E + selective CI wiring
- [x] Task 9: operator/runtime docs + final gates

## Deferrals

No arbitrary-schema framework, product provisioning command, administrator
credential storage, second schema/migration source, installation UUID, catalog
fingerprint, advisory-lock redesign, database-global event-trigger repair,
mount-specific propagation, historical pg_dump, or behavior change for legacy
Postgres / PGLite.

## Privacy risk

Low-medium. Runtime never stores an administrator URL or password. All
checked-in SQL, tests, and docs use generic placeholders. The E2E creates a
disposable local database + role and never logs the generated application
password. Errors and receipts are sanitized via `redactConnectionInfo()`.
