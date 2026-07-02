# Learning records

Reusable lessons, decision rules, and failure modes distilled from completed
work. After finishing a task, add a record here when the work produced
something a future contributor (or agent) should not have to rediscover.

Conventions:

- One lesson per file: `YYYY-MM-DD-title.md`. If a lesson can grow (evidence,
  variants), use a folder `YYYY-MM-DD-title/` with an `index.md`.
- Include what was learned, the evidence, the scope, and when to apply it
  again.
- Redact private identifiers to placeholders (`alice-example`, `acme-example`,
  `fund-a`) before writing — these records are public repo artifacts.
- Update this README's list when adding, splitting, or retiring a record.

Related record homes: incident post-mortems live in
[`../incidents/`](../incidents/2026-05-20-lsd-cost-explosion.md); distill the
reusable lesson from a post-mortem into a record here when it generalizes
beyond the incident. Cross-cutting invariants that must load every session
belong in [`../../CLAUDE.md`](../../CLAUDE.md), not here.

## Records

- [2026-07-03 — config planes, region-scoped keys, and IPv6 black-holes](2026-07-03-config-planes-and-china-networking.md)
  — six lessons from a China-network Supabase + DashScope deployment: DB-plane
  config writes that silently no-op, workspace-scoped API keys, the IPv6-only
  direct host hang, search_path-as-startup-parameter, PostgREST read-only
  STABLE RPCs, and pattern-based (never value-based) log redaction.
- [2026-07-03 — reference-map rows can misroute on filename collisions](2026-07-03-reference-map-filename-collisions.md)
  — verify a router row's target covers the row's topic; filename match is not
  evidence.
