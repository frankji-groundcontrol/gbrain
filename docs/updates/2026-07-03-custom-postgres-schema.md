# Run the brain in a custom Postgres schema

- **Shipped:** 2026-07-03 (branch `franky`)
- **Status:** shipped
- **Scope:** Postgres engine — schema isolation

## What changed

The brain's ~60 tables can now live in a dedicated Postgres schema instead of
`public`. Add a `?search_path=<schema>,extensions,public` suffix to the
connection URL and every table, index, trigger, and migration resolves through
it — postgres.js forwards the unknown query parameter as a Postgres startup
parameter, verified through Supabase's Supavisor pooler in transaction mode.

## Why

On a shared database — a Supabase project that also hosts an app, a corporate
Postgres with other tenants — putting gbrain in `public` is messy and widens the
attack surface (Supabase exposes `public` through PostgREST by default). A
dedicated schema keeps the brain self-contained and invisible to the REST API.

## How to use

Create the schema first (search_path silently skips schemas that don't exist,
so a missing schema would land the tables in `extensions`), then init:

```sql
CREATE SCHEMA IF NOT EXISTS gbrain AUTHORIZATION postgres;
```

```bash
export GBRAIN_DATABASE_URL='postgresql://…pooler.supabase.com:6543/postgres?search_path=gbrain,extensions,public'
gbrain init --non-interactive --embedding-model dashscope:text-embedding-v4 --embedding-dimensions 1536
```

Path order matters: brain schema first (so `current_schema()` resolves to it),
`extensions` (the `vector` type on Supabase), `public` last (`pg_trgm`). Use a
lowercase, unquoted-safe name — mixed-case/hyphenated names are not supported.
Full guide: [`../guides/custom-schema-deployment.md`](../guides/custom-schema-deployment.md).

## What made it work

Two classes of hardcoded `public` used to break schema isolation and are now
fixed:

- **Trigger functions** in `schema.sql` pinned `SET search_path = pg_catalog,
  public` while referencing tables/sequences, so every page write resolved
  `pages` back to `public`. They now pin `SET search_path FROM CURRENT`,
  capturing the connection's search_path at creation (the security property is
  preserved).
- **Diagnostic probes** in `doctor.ts`, `schema-verify.ts`,
  `embedding-dim-check.ts`, `destructive-guard.ts`, `postgres-engine.ts`, and
  `migrate.ts` filtered on literal `'public'`; they now use `current_schema()`.

Two things stay deliberately `public`-scoped: **migration v35's auto-RLS event
trigger + backfill** (it guards PostgREST exposure of `public`; a custom schema
isn't REST-exposed) and **v120's function re-pin** (a no-op in a custom schema,
where the FROM CURRENT creation pin is already correct). Do NOT convert these.

## Under the hood

- `src/schema.sql` (+ generated `src/core/schema-embedded.ts`, regen with
  `bun run build:schema`) — trigger `FROM CURRENT` pins.
- `src/commands/doctor.ts`, `src/core/schema-verify.ts`,
  `src/core/embedding-dim-check.ts`, `src/core/destructive-guard.ts`,
  `src/core/postgres-engine.ts`, `src/core/migrate.ts` — `current_schema()` probes.
- KEY_FILES entries: `schema.sql`, `migrate.ts` (v35 exception note).
- RLS in a custom schema: [`../guides/rls-and-you.md`](../guides/rls-and-you.md).

## Tests

Covered by the existing `test/schema-verify.test.ts`,
`test/embedding-dim-check.test.ts`, `test/destructive-guard.test.ts`,
`test/migrate.test.ts` suites (behavior is identical on a default `public`
install; the change is `'public'` → `current_schema()`).
