# Groundcontrol Dedicated Postgres Schema Design

**Date:** 2026-07-12  
**Status:** Approved for implementation planning  
**Target:** GBrain Postgres engine on Supabase, region `aws-1-ap-southeast-1`

## Goal

Run GBrain in a dedicated Supabase schema named `groundcontrol` through one restricted login role, `groundcontrol_app`, without letting GBrain create or modify objects in `public`, `extensions`, or other schemas.

The design must preserve existing behavior for default-`public` Postgres installations, URL-driven custom-schema installations, and PGLite.

## Requirements

1. Dedicated mode is explicit rather than inferred from a URL.
2. `groundcontrol_app` owns and migrates only the `groundcontrol` schema and its objects.
3. `groundcontrol_app` is not a superuser and does not have `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, or replication privileges.
4. `public` and `extensions` are read-only dependency schemas for this role.
5. `public` is excluded from the application search path.
6. Both transaction and direct/session pools resolve to the same schema before migration starts.
7. Existing default-`public`, URL-driven custom-schema, and PGLite behavior does not change.
8. Failures occur before application DDL when identity, schema, role, extension, or connection settings disagree.
9. Recovery is forward-only: correct the cause and rerun. GBrain does not automatically drop schemas, roles, or data.
10. Database passwords and URL credentials never appear in logs, receipts, tests, or checked-in files.

## Approaches Considered

### 1. Explicit `groundcontrol` mode using existing unqualified SQL

**Chosen.** Add one file-plane setting and strengthen the existing `search_path` and `current_schema()` seams. Keep the embedded schema and migration registry.

This is the smallest design that makes the deployment boundary explicit and testable without duplicating SQL or inventing a second migration system.

### 2. Keep URL-only custom schemas

This requires fewer source changes, but every caller must preserve the same query suffix. Primary, direct, worker, mount, and reconnect paths can silently drift. It also cannot express the stricter dedicated-mode migration behavior without guessing intent from a URL.

### 3. Build a generic arbitrary-schema abstraction

A broad abstraction could qualify every object and support arbitrary extension layouts, identities, and historical fixtures. That scope is not needed for this deployment and would create substantially more configuration, migration, and testing surface.

## Configuration

Add an optional file-plane field:

```json
{
  "engine": "postgres",
  "postgres_schema": "groundcontrol"
}
```

Environment override:

```text
GBRAIN_POSTGRES_SCHEMA=groundcontrol
```

`postgres_schema = "groundcontrol"` activates this dedicated mode. No other value is accepted in this first implementation. This is intentionally not a general arbitrary-schema API.

The setting lives in local configuration because it is required before GBrain can connect to the database-resident configuration table.

Legacy installations without this field continue to use their current URL and `search_path` behavior unchanged.

## Connection Resolution

A shared pure helper materializes this authoritative startup path onto the primary and direct URLs:

```text
groundcontrol,extensions
```

`pg_catalog` remains PostgreSQL's implicit first lookup namespace. `public` is not included.

Rules:

1. If a URL has no `search_path`, add the authoritative value.
2. If a URL already has `search_path`, it must exactly match the authoritative value after normal URL decoding and comma/whitespace normalization.
3. A conflicting path fails before a pool is opened. GBrain never silently retargets a URL.
4. A derived Supabase direct URL preserves the normalized primary query string.
5. An explicit direct URL is normalized and validated independently.
6. The primary and direct effective paths must agree.
7. Reconnect, worker, sync, import, and reflex paths reuse the complete resolved `EngineConfig`; they do not reconstruct `{ database_url }` manually.

The normal configuration path performs normalization. The Postgres connection boundary performs a defensive validation so library callers cannot bypass the invariant.

## Role and Ownership Boundary

The operator provisions one login role:

```text
groundcontrol_app
  LOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
```

Effective rights:

| Scope | Rights |
|---|---|
| Database `postgres` | `CONNECT` |
| Schema `groundcontrol` | Owner; `USAGE`, `CREATE` |
| Objects in `groundcontrol` | Owner |
| Schema `extensions` | `USAGE` only |
| Schema `public` | `USAGE` only |
| Public tables and sequences | None |
| Create outside `groundcontrol` | Denied |

The role owns the dedicated schema because it must bootstrap and migrate its own objects without a permanent privileged migration credential. It therefore has DDL authority inside its own brain, but nowhere else.

GBrain does not store an administrator URL. Provisioning is an operator action through the existing authenticated Supabase administrative connection.

When prerequisites are missing, `gbrain init` fails before mutation and prints redacted copy-paste SQL for the operator. A separate provisioning command is deferred until repeated use demonstrates that it is needed.

## Extension Contract

Dedicated mode treats extensions as administrator-managed database dependencies.

Required placement for this Supabase deployment:

| Extension | Required schema |
|---|---|
| `vector` | `extensions` |
| `pg_trgm` | `public` |

`groundcontrol_app` has schema `USAGE` but no `CREATE` in either dependency schema.

Dedicated mode:

- does not run `CREATE EXTENSION`;
- does not move extensions;
- does not own extension objects;
- does not alter extension grants;
- requires PostgreSQL 13 or later and uses core `gen_random_uuid()` rather than requiring `pgcrypto`.

Because `public` is not on the search path, the few trigram dependencies are explicitly qualified:

```sql
public.similarity(...)
OPERATOR(public.%)
public.gin_trgm_ops
```

The implementation must identify all runtime, bootstrap, and migration trigram references rather than patching only the first observed call site.

Legacy extension creation and PGLite behavior remain unchanged outside dedicated mode.

## Startup and Preflight

Initialization runs in this order:

1. Resolve `postgres_schema` and normalize both database URLs.
2. Open the pool classes required by the requested operation in quarantine.
3. On each opened pool class, assert:
   - `current_user = 'groundcontrol_app'`;
   - `current_schema() = 'groundcontrol'`;
   - `groundcontrol` is owned by `current_user`;
   - the role is neither superuser nor `BYPASSRLS`;
   - the role cannot create in `public` or `extensions`;
   - required extensions exist in the expected schemas.
4. Abort and close connections on any mismatch.
5. Run the existing schema replay and migration registry.
6. Verify object placement, ownership, migration version, and representative runtime behavior.
7. Persist local configuration only after final verification succeeds.

No connection UUID, database-global marker, public catalog fingerprint, or per-checkout attestation is added. The fixed configuration, URL agreement, runtime role, schema ownership, and object placement are the identity boundary.

## Bootstrap

Reuse the existing embedded schema. Do not add a second schema file or generate schema-specific SQL.

In dedicated mode, schema replay:

- omits `CREATE EXTENSION` statements;
- creates unqualified GBrain objects through the authoritative startup path;
- retains `SET search_path FROM CURRENT` for GBrain-owned functions;
- omits RLS work that exists to protect API-exposed `public` tables;
- never creates an object outside `groundcontrol`.

The existing schema-local `config` table and its `version` row remain the sole migration marker. No installation UUID or second ledger is introduced.

## Migration Behavior

Keep the existing migration registry and monotonic `config.version`.

Dedicated-mode branches are narrow:

- **v24, v29, and v31:** retain application table and index creation; skip public-only RLS privilege checks and RLS-only work that requires `BYPASSRLS`.
- **v35:** record the migration as complete without creating or replacing the database-global event trigger and without backfilling or altering `public`.
- **v120:** target the validated current schema where application objects are involved; preserve intentionally legacy-public behavior outside dedicated mode.
- **Catalog probes:** scope GBrain-owned objects through `current_schema()` or the target namespace OID. Same-named public objects must not satisfy dedicated-mode migration checks.
- **Retrieval upgrade planner:** replace the unintended literal `table_schema = 'public'` probe with `current_schema()`.
- **Transactional migrations:** schema work, verification, and version advancement commit together through the existing transaction mechanism.
- **Non-transactional migrations:** retain the existing reserved-connection/idempotent postcondition mechanism; version advancement occurs only after verification succeeds.

A legacy `auto_rls_on_create_table` event trigger may already exist. Dedicated mode neither requires, inspects, repairs, replaces, nor drops it. The guarantee is that dedicated initialization does not mutate public or database-global policy.

The existing advisory-lock connection-affinity defect is real but not caused by dedicated schemas. It remains separate work; this feature does not add a lock table, heartbeat, new key derivation, or migration-runner rewrite.

## Final Verification

Before runtime is enabled, verify:

1. `current_user`, `current_schema()`, and schema ownership match the dedicated contract.
2. Primary and direct pools use the same effective path.
3. Required representative tables, indexes, sequences, functions, and triggers exist in `groundcontrol`.
4. Representative GBrain objects are owned by `groundcontrol_app`.
5. No GBrain-owned object exists in `public` or `extensions`.
6. `config.version` is a canonical non-negative integer no newer than the binary.
7. A representative trigger-backed write succeeds.
8. Keyword, trigram, and vector search paths succeed.
9. Public tables and sequences remain inaccessible to `groundcontrol_app`.

Errors must strip URL userinfo and sensitive query parameters before reaching logs or receipts.

## Testing

### Unit tests

Extend focused configuration and direct-URL tests to cover:

- file-plane and environment precedence;
- fixed-value validation;
- URL insertion when `search_path` is absent;
- exact-match acceptance;
- conflicting primary or direct path rejection;
- derived direct URL propagation;
- worker, reconnect, import, sync, and reflex propagation of the complete engine configuration;
- unchanged behavior when dedicated mode is absent.

### Real-Postgres E2E

Add one `DATABASE_URL`-gated lifecycle test using a disposable lowercase schema and a restricted role. It must prove:

1. Fresh initialization succeeds without superuser or `BYPASSRLS`.
2. GBrain objects land in the disposable schema and are owned by the restricted role.
3. No GBrain object or public/global policy is created or changed outside that schema.
4. A page write exercises schema-pinned trigger functions.
5. Keyword, qualified trigram, and vector behavior works.
6. Public tables cannot be selected or mutated by the role.
7. A second initialization is idempotent.
8. Dedicated v35 advances the migration version without database-global/public work.
9. Wrong role, schema, search path, extension placement, or primary/direct agreement fails before application DDL.
10. Cleanup removes only the disposable role/schema created by the test.

### Existing suites

- Default-public Postgres behavior remains covered by the current E2E suite.
- PGLite behavior remains covered by the current parity and unit suites.
- The new E2E is wired into selective E2E mapping for schema, connection, and migration changes.
- A historical pg_dump and heavy-matrix expansion are deferred. Existing readable down-mutation fixtures remain the preferred method until a reproduced defect requires state they cannot model.

## Rollout

1. Land the implementation and all unit/E2E coverage before touching the target project.
2. Run the lifecycle test against a disposable Supabase project with the production extension layout.
3. Back up the target project.
4. Through `supabase-franky`, create `groundcontrol_app`, establish the `groundcontrol` ownership boundary, and apply the minimum grants.
5. Configure both regional pool URLs for `aws-1-ap-southeast-1` without a conflicting `search_path`.
6. Run preflight only. Stop on any identity, role, schema, or extension mismatch.
7. Initialize under `groundcontrol_app`.
8. Verify ownership, object placement, migration version, public-table denial, and primary/direct agreement.
9. Persist configuration after verification.
10. Canary write, read, keyword search, trigram search, vector search, sync, and background worker paths.

On failure, retain sanitized diagnostics, correct the cause, and rerun forward. Schema or role teardown is a separate, explicitly approved administrator operation after backup.

## Non-Goals and Deferrals

- No arbitrary custom-schema framework.
- No automatic role, schema, or extension provisioning by the restricted path.
- No administrator credential stored in GBrain.
- No public catalog fingerprint or connection UUID.
- No second migration framework or migration ledger.
- No historical pg_dump fixture in this wave.
- No mount-specific dedicated-schema expansion.
- No advisory-lock redesign in this wave.
- No PGLite or default-public behavior change.
- No automatic rollback, downgrade, role deletion, schema deletion, or data deletion.

## Security and Privacy Impact

This feature reduces the blast radius of the GBrain runtime credential to one owned schema. It deliberately preserves only dependency-schema `USAGE`, denies application access to public relations, and fails before DDL when the connection is misrouted.

The implementation and tests must use generic placeholders in checked-in artifacts. Database passwords, connection userinfo, project-specific private data, and credential-bearing URLs must never be committed or emitted unsanitized.
