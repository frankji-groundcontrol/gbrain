# Config planes, region-scoped keys, and IPv6 black-holes (2026-07-03)

Lessons from deploying a brain to a Supabase `gbrain` schema from a
mainland-China network with DashScope `text-embedding-v4` embeddings. Each of
these cost real debugging time; all are now fixed in code or pinned by tests
on the `franky` branch.

## 1. The file-plane / DB-plane split eats silent failures

`gbrain config set provider_base_urls.dashscope <china-url>` **looks** like it
works: the key passes validation (it's in `KNOWN_CONFIG_KEY_PREFIXES`), the
command prints "Set …", and `gbrain config get` echoes the value back. But it
writes the DB config table, and nothing in the embed pipeline reads
`provider_base_urls` from the DB plane — the gateway builds `base_urls`
exclusively from `~/.gbrain/config.json` + a fixed set of env vars. The
override was a total no-op and every probe kept hitting the intl endpoint.

**Rule of thumb:** anything the AI gateway consumes (provider keys, base
URLs, embedding model/dims) is file-plane. When a config write "succeeds" but
behavior doesn't change, suspect the plane, not the value.

## 2. DashScope keys are region- AND workspace-scoped

One account can hold multiple keys that are mutually incompatible with each
other's endpoints, and a workspace endpoint only serves the models that
workspace enabled — `Model not exist.` from an image workspace does not mean
the model id is wrong. Curl the exact base URL + model + key combination
before wiring anything (see `docs/ai-providers/dashscope.md`).

## 3. Supabase's derived direct host black-holes on some networks

`db.<ref>.supabase.co:5432` is IPv6-only. From this network, TCP connects
(so `nc -z` lies to you) but the Postgres handshake never completes, and
`initSchema` — which routes DDL through the derived direct pool with no
fallback — hangs forever with zero server-side activity. Two init attempts
died this way at 10+ minutes each.

Fix layers: `direct_database_url` file-plane field (points DDL/bulk at the
session-mode pooler, IPv4-friendly), threaded through `loadConfig →
toEngineConfig → ConnectionManager`, plus hand-threading in `init.ts` /
`migrate-engine.ts` which build their EngineConfig from a bare URL and never
call `toEngineConfig` — that second half is the part a config-only fix
misses, and static tripwire tests now pin both call sites.

## 4. postgres.js URL query params are startup parameters

`?search_path=gbrain,extensions,public` on the connection URL propagates
through Supavisor (verified in transaction mode) to every backend — that one
suffix is ~95% of custom-schema support. The remaining 5% was hardcoded
`public` in trigger-function pins (`SET search_path FROM CURRENT` fixes) and
diagnostic probes (`current_schema()` fixes).

## 5. PostgREST runs STABLE RPCs in READ ONLY transactions

A `last_used_at` UPDATE inside the API-key resolver made every authenticated
REST call fail with the same error as an invalid key — while the identical
SQL passed in a normal session. If a SECURITY DEFINER auth helper writes
telemetry, wrap the write in `EXCEPTION WHEN read_only_sql_transaction`.
Corollary: SQL-session tests are not enough; smoke the actual PostgREST
surface.

## 6. The query-embed deadline masquerades as broken embeddings

Even with embeddings 100% present and correct, `gbrain query` returned "No
results" for paraphrase and CJK queries while exact-keyword queries worked.
Cause: search embeds the QUERY at call time under a 6s deadline (built for
stalled providers), and a cold DashScope Beijing round trip exceeds it — the
vector leg silently falls back to keyword. Now configurable:
`search.query_embed_timeout_ms` (20000 for China). Diagnostic that cracked
it: embed the query with curl, run the cosine SQL by hand — data layer
perfect, so the bug had to be client-side between them.

## 7. Chunk `model` labels are stamped at chunking, not embedding

All 3,428 chunks carried `model='zeroentropyai:zembed-1'` (the gateway
default) while holding genuine DashScope v4 1536-dim vectors — the label is
written at chunk-creation time, before any embed call. Harmless to search
and to `embed --stale` (staleness is `embedding IS NULL`), but lies to
humans and future migration tooling. One-line correction after the fact:
`UPDATE content_chunks SET model='<real model>' WHERE embedding IS NOT NULL`.

## 8. Don't build redaction from secret values

Piping process output through `sed "s/$SECRET/***/"` breaks when the secret
contains `/` — and the sed *error message* then leaks a prefix of the secret
into the log you were trying to sanitize. Redact by PATTERN
(`s/sk-[A-Za-z0-9._+-]{8,}/sk-***/g`), never by value.
