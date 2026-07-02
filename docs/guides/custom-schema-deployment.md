# Running the brain in a custom Postgres schema

By default gbrain's ~60 tables land in `public`. On a shared database — a
Supabase project that also hosts an app, a corporate Postgres with other
tenants — that is both messy and a wider attack surface (Supabase exposes
`public` through PostgREST by default). A dedicated schema keeps the brain
self-contained and invisible to the REST API.

## How it works

gbrain uses postgres.js, which forwards unknown connection-URL query
parameters as Postgres **startup parameters** to every pool (the same
mechanism that carries `statement_timeout` through Supabase's Supavisor
pooler, in both session and transaction mode). So schema selection is a URL
suffix, not a config field:

```
postgresql://...pooler.supabase.com:6543/postgres?search_path=gbrain,extensions,public
```

Everything unqualified — table DDL, runtime queries, migration version
tracking in the brain's own `config` table — resolves through that
search_path, giving each schema its own fully independent brain.

## Path ordering matters

- **`gbrain` first** — `current_schema()` must resolve to the brain schema;
  all diagnostics and self-heal probes key off it.
- **`extensions`** — on Supabase the `vector` type lives there; without it in
  the path, `vector(1536)` DDL fails to resolve the type.
- **`public` last** — `pg_trgm` operators commonly live there.

**Create the schema before first connect.** `search_path` silently skips
schemas that don't exist; if `gbrain` is missing, `current_schema()` falls
through to `extensions` and the brain's tables land inside the extensions
schema.

```sql
CREATE SCHEMA IF NOT EXISTS gbrain AUTHORIZATION postgres;
```

Use a lowercase, unquoted-safe name. Mixed case or hyphens ("G-Brain")
require identifier quoting in every SQL statement forever and are not
supported.

## What the codebase guarantees (since the custom-schema patch)

Two classes of hardcoded `public` used to break this:

1. **Trigger functions** in `schema.sql` were pinned
   `SET search_path = pg_catalog, public` while referencing tables and
   sequences — every page INSERT/UPDATE resolved `pages` back to `public`.
   They are now pinned `SET search_path FROM CURRENT`, capturing the
   connection's search_path at creation time. The security property (a pinned,
   non-hijackable path on trigger functions) is preserved.
2. **Diagnostic probes** (schema-verify self-heal, embedding-dim checks, the
   facts halfvec cast probe, doctor's RLS/index checks, destructive-guard,
   migration v24's self-heal conditionals) filtered
   `information_schema`/`pg_catalog` on `'public'`. They now use
   `current_schema()` — identical behavior on default installs.

Two things stay deliberately public-scoped:

- **Migration v35's auto-RLS event trigger + backfill** — that safety net is
  about PostgREST exposure of `public`; a non-exposed custom schema doesn't
  need it. Note the event trigger is database-global and idempotent
  (`DROP ... IF EXISTS` + recreate), so re-initializing in a new schema on a
  database that already ran v35 is safe.
- **Migration 120's function re-pin** (`ALTER FUNCTION public.%I ... SET
  search_path = pg_catalog, public`) no-ops in a custom schema; the
  FROM CURRENT creation pin is already correct there.

## Supabase specifics

- **Use the pooler URL as the primary connection.** Port 6543 (transaction
  mode) is auto-detected and disables prepared statements; a port-5432
  session-mode pooler URL also works.
- **The derived direct host can hang.** For DDL and bulk writes gbrain derives
  `db.<ref>.supabase.co:5432` — an IPv6-only host. On IPv6-hostile networks
  (observed from mainland China: TCP opens, the Postgres handshake never
  completes) `initSchema` hangs forever. Point the direct pool at the
  session-mode pooler instead, in `~/.gbrain/config.json`:

  ```json
  "direct_database_url": "postgresql://...pooler.supabase.com:5432/postgres?search_path=gbrain,extensions,public"
  ```

  (env `GBRAIN_DIRECT_DATABASE_URL` overrides; `GBRAIN_DISABLE_DIRECT_POOL=1`
  is the single-pool kill switch.) Keep the `?search_path=` suffix on ANY
  explicit direct URL — it is a separate connection and needs its own pin.
- **PostgREST**: the custom schema is not exposed by default. That is the
  point. If external consumers need scoped access, put SECURITY DEFINER RPC
  functions (with pinned `search_path`) in `public` rather than exposing the
  schema.

## Full deployment sequence

```bash
# 1. Create the schema (SQL editor / MCP / psql, as the connecting role)
#    CREATE SCHEMA IF NOT EXISTS gbrain AUTHORIZATION postgres;

# 2. Init with the search_path suffix on the URL (env, never argv)
export GBRAIN_DATABASE_URL='postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:6543/postgres?search_path=gbrain,extensions,public'
gbrain init --non-interactive \
  --embedding-model dashscope:text-embedding-v4 --embedding-dimensions 1536 --json

# 3. Verify
gbrain doctor          # probes now run against current_schema()
```

The connection URL (with suffix) persists to `~/.gbrain/config.json`, so
every subsequent command and daemon inherits the schema pin.
