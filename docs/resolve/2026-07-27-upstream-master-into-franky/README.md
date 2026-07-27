# Resolve upstream master into franky (2026-07-27)

Sixteen-file conflict. Directory form because the resolution needed a
cross-file coherence argument (see [decisions.md](decisions.md)) rather than a
per-file choice.

## Context

Sync path, unchanged from the [2026-07-12 record](../2026-07-12-upstream-master-into-franky.md):

```text
upstream/master -> origin/master -> origin/franky
```

- `origin`: `https://github.com/frankji-groundcontrol/gbrain.git`
- `upstream`: `https://github.com/garrytan/gbrain.git` (fetch only; push URL disabled)

Refs at the time of the merge:

| Ref | Commit | Version |
|---|---|---|
| `franky` (HEAD before merge) | `28ba0598` | 0.42.59.0 |
| `upstream/master` | `3fafb69b` | 0.42.66.0 |
| `origin/master` (after pin) | `3fafb69b` | 0.42.66.0 |
| **resulting merge commit** | `5058426e` | 0.42.66.0 |

`origin/master` was fast-forwarded `5008b287..3fafb69b`. The CLAUDE.md
ancestry guard (`git merge-base --is-ancestor origin/master upstream/master`)
passed, confirming the pin had no fork-only commits to reconcile. Nothing was
pushed to `upstream`.

### Why `gbrain upgrade` is the wrong tool here

`gbrain upgrade` runs its internal `git pull` on the checked-out branch. On
this fork that is `franky` against `origin/franky`, so it reports "Already up
to date" while never observing `upstream`. Fork sync is the CLAUDE.md sequence
above, not the upgrade command. `gbrain upgrade` remains correct for a
non-fork checkout tracking `master` directly.

## Conflicted files (16)

Code (10):

- `src/commands/migrate-engine.ts`
- `src/commands/providers.ts`
- `src/core/ai/build-gateway-config.ts`
- `src/core/ai/dims.ts`
- `src/core/ai/gateway.ts`
- `src/core/ai/types.ts`
- `src/core/config.ts`
- `src/core/connection-manager.ts`
- `src/core/embedding-pricing.ts`
- `src/core/import-file.ts`
- `src/core/postgres-engine.ts`

Schema (1): `src/schema.sql`

Docs (2): `README.md`, `docs/architecture/KEY_FILES.md`

Generated (2): `src/core/schema-embedded.ts`, `llms-full.txt` — **not**
hand-merged; regenerated from source (see Verification).

### VERSION, package.json and CHANGELOG.md did NOT conflict

Worth recording because CLAUDE.md warns that "every merge from master will hit
conflicts" on that trio. It did not here, because the fork had never bumped its
own version — both sides read 0.42.59.0, so upstream's 0.42.66.0 applied as a
clean fast-forward and the CHANGELOG entries appended without overlap. The
3-line audit was still run (it agrees at 0.42.66.0); the absence of a conflict
is not a reason to skip it.

## Resolution

Both fork feature themes had to survive intact:

1. **DashScope** — `text-embedding-v4`/`v3`, multimodal search,
   `dashscope_api_key`, the `max_batch_items` item-count cap,
   `dashscopeWorkspaceCompatFetch`.
2. **Dedicated `groundcontrol` Postgres schema** — `postgres_schema`,
   `DEDICATED_SEARCH_PATH`, `normalizeDedicatedPostgresConfig`,
   `direct_database_url` for IPv6-hostile networks, schema-qualified SQL.

Six of the conflicts were pure unions (both sides added adjacent entries to the
same table or interface). The rest needed a judgment call; those are recorded
per-file in [decisions.md](decisions.md), along with the one reconnaissance
finding that settled three of them at once.

## Verification

| Gate | Result |
|---|---|
| Conflict markers, per file | 0 across all 16 |
| `scripts/check-search-path.sh` | EXIT=0 — "all trigger functions in schema base files pin search_path" |
| VERSION / package.json / CHANGELOG audit | all `0.42.66.0` |
| `bun run build:schema` | EXIT=0 — regenerated `src/core/schema-embedded.ts` |
| `bun run build:llms` | EXIT=0 — regenerated `llms.txt` (9063 B), `llms-full.txt` (226244 B) |
| `bun run typecheck` | EXIT=0 |
| Targeted suite, 14 files covering every merged area | 228 pass, 0 fail |
| Two suites that fail after the merge | fail identically at `upstream/master` — see below |

The targeted suite was `providers`, `providers-test-model-base-url`,
`embedding-pricing`, `config`, `loadConfig-merge`, `postgres-dedicated`,
`dedicated-config-persistence.serial`, `migrate-engine-resume`, `import-file`,
`build-llms`, `schema-bootstrap-coverage`, `gateway-embed-model-override`,
`embed-multimodal-batching`, `connection-manager.serial` — chosen to cover each
of the 16 conflicted files.

The two generated files were regenerated rather than resolved. Hand-merging
either produces a file that disagrees with its source and fails its freshness
guard (`test/build-llms.test.ts` for the llms bundles).

### Two test-triage traps, both hit during this merge

**1. A contended `bun test` invents failures.** Running the full suite while
another process held the database produced 78 failures; the same tree produced
228/0 on the targeted suite minutes later. The tell is the timing distribution —
the failures were either flat 5000ms timeouts or 1-5ms setup errors
(`owner_job_id=26 is not present in minion_jobs`), never the millisecond spread
a real assertion failure has. Run one thing at a time; this was hit twice,
the second time by starting an "isolation" run *while the full suite was still
going*.

**2. Failing in isolation still does not mean the merge caused it.**
`test/extract-facts-phase.test.ts` (4 pass / 16 fail) and
`test/phantom-redirect.test.ts` (35 pass / 3 fail) fail cleanly on their own.
Both arrived *with* this merge — upstream rewrote `src/core/cycle/extract-facts.ts`
(+225 lines) and its test (+204) without conflicting. The decisive check is a
worktree at the upstream commit:

```bash
git worktree add /tmp/up-check 3fafb69b
ln -s "$PWD/node_modules" /tmp/up-check/node_modules
cd /tmp/up-check && bun test test/extract-facts-phase.test.ts
```

Result: 4 pass / 16 fail and 35 pass / 3 fail — byte-identical counts. These are
pre-existing upstream failures inherited by the sync, not resolution errors. The
symlinked `node_modules` is what makes this cheap enough to be worth doing.

`bun install` was run to refresh `bun.lock` against the merged `package.json`.
It is slow in this checkout because `package.json` wires a `postinstall` that
runs `gbrain apply-migrations` against the live brain; the lockfile is written
before that hook fires, so the install does not need to complete for the
lockfile to be correct.

## Follow-ups filed by this merge

- `buildProbeGatewayConfig` (`src/commands/providers.ts:52`) has no remaining
  caller in `src/` after taking upstream's `baseGatewayConfig` form. It stays
  exported and still has tests (`test/providers.test.ts`). Left in place
  deliberately — deleting an exported symbol is a separate decision from
  resolving a merge.
- The wedged `v0.11.0` / `v0.12.0` data migrations are diagnosed but **not
  cleared** — see [wedged-migrations.md](wedged-migrations.md). Clearing them
  mutates the live brain and is a separate, supervised decision.

Commit hashes in this record are point-in-time receipts, not a promise that the
branch tips remain unchanged.
