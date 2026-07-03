# Update records

One file per shipped, user-facing change. An update record is the modular unit
the version-stamped [`CHANGELOG.md`](../../CHANGELOG.md) is not: it lands the
moment a change ships on a branch, before (or independent of) a cut release, so
a feature has a documented home without waiting for a version bump. When a
version is eventually cut, its CHANGELOG entry is assembled from the update
records that landed since the last release.

Conventions:

- One change per file: `YYYY-MM-DD-title.md`. Use a folder
  `YYYY-MM-DD-title/` with an `index.md` only if the change accumulates
  sub-notes over time.
- Write it so a reader can adopt the change without the original task's
  context: what shipped (in user terms), why, how to use it (config keys, env
  vars, commands), and where it lives in code (link the
  [`architecture/KEY_FILES.md`](../architecture/KEY_FILES.md) entries so the
  invariants stay one hop away).
- Point-in-time: records are added, not rewritten. If a later change
  supersedes one, add a closing note at the top rather than editing the body.
- Redact private identifiers to placeholders (`<project-ref>`, `<workspace>`,
  `alice-example`) before writing — these are public repo artifacts.
- Update this README's table when adding, superseding, or retiring a record.

Boundary with neighbors:

- [`../../CHANGELOG.md`](../../CHANGELOG.md) — release history. Version-stamped,
  written at release time, one entry per cut version. Update records feed it;
  they do not replace it.
- [`../architecture/`](../architecture/README.md) + [`../guides/`](../README.md)
  — current-behavior reference. An update record explains a *change* and points
  at the reference doc that now owns the steady-state truth.
- [`../learning/`](../learning/README.md) — the reusable *lesson* a change
  taught ("this was hard because…"), not the change itself.
- [`../designs/`](../designs/) — the design rationale behind a change.

## Records

| Update | Shipped | Status |
|---|---|---|
| [2026-07-03 — DashScope text-embedding-v4 support](2026-07-03-dashscope-text-embedding-v4.md) | branch `franky` | shipped |
| [2026-07-03 — Run the brain in a custom Postgres schema](2026-07-03-custom-postgres-schema.md) | branch `franky` | shipped |
| [2026-07-03 — `direct_database_url` for IPv6-hostile networks](2026-07-03-direct-database-url.md) | branch `franky` | shipped |
| [2026-07-03 — Configurable query-embed deadline](2026-07-03-query-embed-timeout.md) | branch `franky` | shipped |
| [2026-07-03 — Multi-user sharing layer (deployment-side)](2026-07-03-sharing-layer.md) | branch `franky` | shipped |
