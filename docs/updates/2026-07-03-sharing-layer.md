# Multi-user sharing layer (deployment-side)

- **Shipped:** 2026-07-03 (branch `franky`)
- **Status:** shipped (deployment-side SQL; not gbrain-core)
- **Scope:** Supabase deployment — multi-user read/share access

## What changed

A pure-SQL layer on top of a Supabase-hosted brain that lets multiple users
authenticate with API keys and share pages with each other or with teams, each
choosing what to share and what to keep private. It is applied as a migration on
the deployment, not a change to gbrain-core: the engine still connects over the
Postgres wire as usual and is unaffected.

The layer adds `users`, `teams`, `team_members`, `api_keys`, and `page_shares`
tables in the brain's schema, a `pages.owner_user_id` column, and a set of
`SECURITY DEFINER` RPCs in `public` (PostgREST-exposed) that external callers
reach with the project's publishable key plus a per-user `gbk_…` API key.

## Why

The brain's own tables aren't meant to be exposed to PostgREST or opened to
multiple principals. RPCs give a stable, least-privilege API-key surface:
callers see only pages they own or that were shared to them (directly or via a
team), absence of a share row means private, and missing/unpermitted pages are
indistinguishable (no existence oracle).

## How to use

Apply the migration and run the test suite (it creates fixtures and rolls them
back), then issue keys over the wire as the brain owner:

```sql
SELECT gbrain.admin_issue_api_key('alice-example', 'my-key');   -- returns plaintext ONCE
```

Public RPC surface (via `POST /rest/v1/rpc/...` with publishable key +
`p_api_key`): `gbrain_whoami`, `gbrain_list_shared`, `gbrain_get_page`,
`gbrain_search_shared`, `gbrain_search_vector` (client embeds the query),
`gbrain_put_note`, `gbrain_share_page`, `gbrain_unshare_page`.

## Notes

- The gbrain schema is NOT exposed to PostgREST; enforcement lives in the RPC
  visibility join (`gbrain.visible_pages`), and RLS is enabled on every table as
  deny-by-default defense in depth.
- Gotcha worth remembering: PostgREST runs STABLE RPCs in a READ ONLY
  transaction, so the API-key resolver's `last_used_at` stamp must be
  best-effort (`EXCEPTION WHEN read_only_sql_transaction`) or every
  authenticated read fails like a bad key.

## Under the hood

Design record, migration SQL, and the TDD test suite:
[`../designs/franky-sharing-layer/`](../designs/franky-sharing-layer/README.md).
This is a deployment artifact for a specific Supabase-hosted brain, kept in the
repo as a reusable pattern; no gbrain `src/` code changed.
