# `direct_database_url` for IPv6-hostile networks

- **Shipped:** 2026-07-03 (branch `franky`)
- **Status:** shipped
- **Scope:** Postgres engine — connection routing

## What changed

`direct_database_url` is a new file-plane config field (with env override
`GBRAIN_DIRECT_DATABASE_URL`) that overrides gbrain's derived "direct"
DDL/bulk connection. It is threaded from `loadConfig()` → `toEngineConfig()` →
`ConnectionManager`, and hand-threaded in `init.ts` and `migrate-engine.ts`
(which build their `EngineConfig` from a bare URL before any config is saved).

## Why

For DDL and bulk writes, gbrain derives a direct host
`db.<project-ref>.supabase.co:5432` — which is **IPv6-only**. On IPv6-hostile
networks (observed from mainland China: TCP opens, so `nc -z` lies, but the
Postgres handshake never completes) `initSchema` hangs forever with zero
server-side activity. `GBRAIN_DIRECT_DATABASE_URL` already existed as an
env-only escape hatch, but env vars don't reach daemon-spawned gbrain
processes, and the two bare-URL command paths (`init`, `migrate`) never threaded
it, so they re-derived the IPv6 host and hung regardless.

## How to use

Point the direct pool at the session-mode pooler (IPv4-friendly), in
`~/.gbrain/config.json` — keep the `?search_path=` suffix, it's a separate
connection:

```json
"direct_database_url": "postgresql://…pooler.supabase.com:5432/postgres?search_path=gbrain,extensions,public"
```

Precedence: env `GBRAIN_DIRECT_DATABASE_URL` > file-plane `direct_database_url`
> derived host. `GBRAIN_DISABLE_DIRECT_POOL=1` is the single-pool kill switch
(DDL then runs on the primary pooler under its statement timeout).

## Under the hood

- `src/core/types.ts` — `EngineConfig.direct_database_url`.
- `src/core/config.ts` — `GBrainConfig` field, env-over-file resolution,
  `toEngineConfig` threading.
- `src/core/postgres-engine.ts` — passes it to `ConnectionManager` as
  `opts.directUrl`; `src/core/connection-manager.ts` precedence
  (opts > env > derived).
- `src/commands/init.ts`, `src/commands/migrate-engine.ts` — bare-URL
  hand-threading (a static tripwire test pins both seams so a refactor can't
  drop the thread and reintroduce the hang).
- KEY_FILES entries: `config.ts`, `migrate-engine.ts`.

## Tests

`test/direct-database-url.test.ts` — precedence (opts/env/derived), file-plane
`loadConfig` → `toEngineConfig` plumbing, and the static tripwire that `init.ts`
+ `migrate-engine.ts` still thread the override at their bare-URL connect sites.
