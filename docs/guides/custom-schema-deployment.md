# Running the brain in a custom Postgres schema

By default gbrain's ~60 tables land in `public`. On a shared database — a
Supabase project that also hosts an app, a corporate Postgres with other
tenants — that is both messy and a wider attack surface (Supabase exposes
`public` through PostgREST by default). A dedicated schema keeps the brain
self-contained and invisible to the REST API.

> "Schema" here means a **Postgres schema** (the SQL namespace tables live in),
> not the knowledge-base directory structure in `GBRAIN_RECOMMENDED_SCHEMA.md`
> or the schema packs in `docs/architecture/schema-packs.md`. Those are
> unrelated concepts that happen to share the word.

## Legacy URL-pinned mode (not restricted)

Legacy custom-schema installs use postgres.js, which forwards unknown connection-URL query
parameters as Postgres **startup parameters** to every pool (the same
mechanism that carries `statement_timeout` through Supabase's Supavisor
pooler, in both session and transaction mode). In this mode schema selection
is a URL suffix, not a config field:

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

---

## Restricted dedicated mode (`postgres_schema: "groundcontrol"`) — v0.43, 2026-07

The legacy URL-suffix approach above relies on every connection preserving
the same `?search_path=` query parameter. That is fragile across reconnect,
worker, sync, import, and mount paths, and it cannot express the stricter
dedicated-mode migration behavior. The explicit `postgres_schema` field
solves both: a single file-plane flag drives URL normalization, fail-before-
DDL preflight, dedicated bootstrap rendering, narrow migration variants,
final verification, and persistence gating.

### Track 1 — Administrator provisioning (NEVER executed by gbrain)

The operator provisions one login role and the schema boundary through the
authenticated Supabase administrative connection. GBrain never stores an
administrator URL or password.

```sql
-- 1. The restricted login role. NOSUPERUSER / NOBYPASSRLS / NOCREATEDB /
--    NOCREATEROLE / NOREPLICATION are all required — dedicated preflight
--    rejects any of these set.
CREATE ROLE groundcontrol_app LOGIN
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD '<application-password>';

-- 2. The owned schema.
CREATE SCHEMA groundcontrol AUTHORIZATION groundcontrol_app;

-- 3. Dependency schemas + extensions. The role has USAGE but NOT CREATE
--    on either. Placement is enforced by preflight:
--      vector   → extensions
--      pg_trgm  → public
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector  SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

-- 4. Effective CREATE denial on dependency schemas.
GRANT USAGE ON SCHEMA public      TO groundcontrol_app;
GRANT USAGE ON SCHEMA extensions  TO groundcontrol_app;
REVOKE CREATE ON SCHEMA public     FROM PUBLIC;
REVOKE CREATE ON SCHEMA extensions FROM PUBLIC;
REVOKE CREATE ON SCHEMA extensions FROM groundcontrol_app;

-- 5. The role owns its schema and can create objects there.
GRANT CONNECT ON DATABASE <dbname> TO groundcontrol_app;
GRANT CREATE  ON SCHEMA groundcontrol TO groundcontrol_app;
```

> **Warning:** revoking `CREATE` from `PUBLIC` on `public` is a
> **database-wide** change that affects every role that relies on the
> default. Audit your database before applying it.

### Track 2 — Runtime configuration (GBrain side)

Set the file-plane startup field. Env (`GBRAIN_POSTGRES_SCHEMA`) wins over
the file value; only the literal `"groundcontrol"` is accepted.

```bash
export GBRAIN_DATABASE_URL='postgresql://groundcontrol_app:<pw>@<region>.pooler.supabase.com:6543/postgres'
export GBRAIN_POSTGRES_SCHEMA=groundcontrol
gbrain init --non-interactive \
  --embedding-model <provider:model> --embedding-dimensions <N>
```

Or in `~/.gbrain/config.json`:

```json
{
  "engine": "postgres",
  "database_url": "postgresql://groundcontrol_app:<pw>@...",
  "postgres_schema": "groundcontrol"
}
```

`gbrain config set postgres_schema` is **hard-rejected** — the DB-plane
store is read after connecting, so it cannot size the schema. Edit the file
or set the env var.

### What GBrain guarantees in dedicated mode

1. **URL normalization**: both `database_url` and `direct_database_url` are
   stamped with `?search_path=groundcontrol,extensions`. A conflicting
   `search_path` fails before any pool opens. Primary/direct agreement is
   enforced.
2. **Fail-before-DDL preflight** (`PostgresEngine.runDedicatedPreflight`):
   on every distinct pool, before the advisory lock or any application DDL,
   asserts `current_user = groundcontrol_app`, `current_schema() =
   groundcontrol`, schema ownership, no superuser/BYPASSRLS/CREATEDB/
   CREATEROLE/REPLICATION, no CREATE on public/extensions, CREATE on
   groundcontrol, and exact extension placement. Any mismatch closes the
   pools and throws a redacted error.
3. **Dedicated bootstrap rendering**: `CREATE EXTENSION` statements and the
   terminal RLS `DO $$` block are stripped. GBrain DDL + `SET search_path
   FROM CURRENT` functions are retained. Nothing is created outside
   `groundcontrol`.
4. **Narrow migration variants**: v24/v29/v35 (public-RLS work) are no-ops;
   v31 keeps the table/index DDL, drops the BYPASSRLS gate; v120 targets
   `current_schema()`. Catalog probes use `current_schema()`.
5. **Final verification** (`PostgresEngine.verifyDedicatedPostgres`): after
   migrations, schema verification, and zombie-index cleanup, re-asserts
   the contract + representative object existence/ownership + no cross-
   schema leakage + version sanity.
6. **Persistence gating**: `init` and `migrate-engine` persist
   `postgres_schema` only after final verification succeeds. A failed
   dedicated migrate keeps the old config and resume manifest.
7. **Redacted errors**: every dedicated error routes through
   `redactConnectionInfo()` so URL userinfo and passwords never reach logs.

### Recovery

Recovery is **forward-only**. Correct the cause and rerun. GBrain never
automatically drops schemas, roles, or data. Schema or role teardown is a
separate, explicitly approved administrator operation after backup.

### Verification

```bash
gbrain doctor          # schema_version + object placement
gbrain stats           # confirms the brain is live in groundcontrol
```
