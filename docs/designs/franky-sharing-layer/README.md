# franky sharing layer (dated design record, 2026-07-03)

Multi-user read/share access to the franky Supabase brain (`gbrain` schema on
project `<project-ref>`), designed and deployed 2026-07-03. This is a
**deployment-side** layer: pure SQL on top of the engine's tables, no gbrain
source changes. The CLI/skills that consume it come later.

## Requirements (as stated)

- `users`, `teams`, `api_keys` tables under the `gbrain` schema
- users authenticate with an API key
- content shareable within teams; the owner chooses what to share and what
  stays private, per page
- only authenticated users can access their content, with permissions
- RLS, RPCs, and helper views to manage permissions

## Architecture

```
CLI / skill                    Supabase edge                      Postgres
───────────                    ─────────────                      ────────
publishable key  ──────────►   PostgREST (anon role)
+ per-user gbk_ API key            │  only schemas: public,…      gbrain schema is
                                   ▼                              NOT exposed
                          public.gbrain_* RPCs   ──────────────►  SECURITY DEFINER,
                          (EXECUTE granted to anon)               pinned search_path,
                                                                  visibility joins
gbrain engine (Frank)  ───────────────────────────────────────►  wire protocol as
                                                                  postgres (BYPASSRLS)
```

Three trust rings:

1. **Brain owner (Frank)** — wire protocol, `postgres` role, sees everything.
   Admin functions (`gbrain.admin_*`) live here: create users/teams, issue and
   revoke keys, share brain-owned pages.
2. **Authenticated users** — publishable key gets them to PostgREST; a
   per-user `gbk_…` API key (sha256-stored, prefix-indexed, revocable,
   expirable) authenticates them inside each RPC. They see: pages they own
   (created via `gbrain_put_note`) + pages shared to them directly or via a
   team. Absence of a share row = private.
3. **Anonymous** — can reach the RPCs (and gets `invalid_api_key`) and nothing
   else: no `USAGE` on the gbrain schema, RLS enabled on every table with no
   permissive policies (deny-by-default for any future non-BYPASSRLS role).

## Files

- [`migration.sql`](migration.sql) — the full layer: 5 tables,
  `pages.owner_user_id`, auth/ACL helpers, 6 admin functions, 8 public RPCs,
  2 helper views, blanket RLS, tight grants. Applied via Supabase MCP
  `apply_migration` (`franky_sharing_layer_v1` + `sharing_layer_fix_readonly_last_used`).
- [`tests.sql`](tests.sql) — the behavioral suite written FIRST (TDD): ~40
  assertions across key lifecycle, ownership, share/unshare, owner-only
  enforcement, write-beats-read merge, existence-leak resistance, FTS +
  vector-search visibility filtering, RLS/grants posture. Self-contained,
  rolls back its fixtures; re-run any time.

## API surface (public schema, PostgREST `/rest/v1/rpc/...`)

| RPC | Purpose |
|---|---|
| `gbrain_whoami(p_api_key)` | identity + team slugs |
| `gbrain_list_shared(p_api_key, p_limit, p_offset)` | everything visible, with permission + via |
| `gbrain_get_page(p_api_key, p_slug)` | full content; missing ≡ unpermitted (`not_found`) |
| `gbrain_search_shared(p_api_key, p_query, p_limit)` | FTS (websearch syntax) over visible pages |
| `gbrain_search_vector(p_api_key, p_embedding float8[1536], p_limit)` | cosine search over visible chunks; the CLIENT embeds the query (DashScope v4 @1536) |
| `gbrain_put_note(p_api_key, p_title, p_content, p_type)` | create an owned page in the `user-notes` source |
| `gbrain_share_page(p_api_key, p_slug, kind, grantee, permission)` | owner-only per-page grant (user or team, read or write) |
| `gbrain_unshare_page(p_api_key, p_slug, kind, grantee)` | revoke a grant |

Admin (wire-only, gbrain schema): `admin_create_user`, `admin_create_team`,
`admin_add_member`, `admin_issue_api_key` (returns plaintext exactly once),
`admin_revoke_api_key`, `admin_share_page` (for brain-owned pages).

## Decisions + gotchas worth remembering

- **RPCs in `public`, schema unexposed.** The franky project hosts 7+ other
  app schemas; exposing `gbrain` to PostgREST was never on the table. RPCs
  give a stable, versionable API contract instead.
- **Enforcement lives in the RPC visibility join** (`gbrain.visible_pages`),
  not RLS — SECURITY DEFINER functions run as `postgres` (BYPASSRLS), so RLS
  cannot constrain them. RLS is still enabled everywhere as defense-in-depth
  for future scoped roles and to keep `gbrain doctor`'s RLS check green.
- **PostgREST runs STABLE RPCs in READ ONLY transactions.** The
  `last_used_at` stamp inside `resolve_api_key` aborted every authenticated
  read over REST (identical symptom to a bad key) until it was made
  best-effort (`EXCEPTION WHEN read_only_sql_transaction`). SQL-session tests
  alone would never have caught it — always smoke through PostgREST too.
- **'write' > 'read' as text** makes the strongest-permission merge a
  one-line `max()`.
- Missing and unpermitted pages both return `not_found` — no existence oracle.
- Rate limiting is NOT in this layer (v1). If keys ever leave the team,
  front with Supabase edge functions or a gateway.

## Verification log (2026-07-03)

- RED: suite failed at T1a before migration (relations missing).
- GREEN: full suite passed post-migration (single DO block, exception-free).
- REST smokes: bogus key → `invalid_api_key`; `gbrain` schema invisible to
  PostgREST; real key → whoami/put_note/search round trip OK.
- First real principal: user `franky` + API key (plaintext appended to
  `~/.env` as `GBRAIN_API_KEY`, never stored server-side, never in any log).
