# Wedged v0.11.0 / v0.12.0 data migrations

Companion to [README.md](README.md). Diagnosed during this sync; **not cleared**
— clearing mutates the live brain.

## How a version wedges

`src/commands/apply-migrations.ts` appends one JSONL row per attempt to
`~/.gbrain/migrations/completed.jsonl` (path via `preferences.ts:completedJsonlPath()`,
routed through `gbrainDir()` so `GBRAIN_HOME` isolates it in tests).

`statusForVersion()` counts *consecutive* `partial` rows from the end, stopping
at the first `retry` or `complete`. At `MAX_CONSECUTIVE_PARTIALS = 3` the version
reports `wedged` and is skipped on every subsequent run — silently, since the
chain moves on to the next version.

That is why a wedge survives an upgrade that otherwise looks successful: the
`bun install` postinstall during this merge ran v0.12.2 → v0.32.2 to completion
while stepping over both wedged versions without comment.

## What the ledger actually says

Three distinct causes, only one of which is a real defect:

| Version | Attempts | Failure | Verdict |
|---|---|---|---|
| v0.11.0 | 2 | `schema: column "event_page_id" does not exist` | **Stale.** Upstream migration `[121] timeline_entries_event_page_id` supplies the column, and this sync applied it. |
| v0.11.0 | 1 | `schema: [groundcontrol] verify: GBrain objects leaked into dependency schemas (public.pages)` | **Genuine.** Fork-specific, dedicated-schema. The only real problem here. |
| v0.12.0 | 2 | `backfill_timeline failed: … 37 \| <<<<<<< HEAD  error: Unexpected <<` | **Self-inflicted.** See below. |

### The v0.12.0 failure is an artifact of this merge

`~/.local/bin/gbrain` runs from source (`bun /home/frankji/.local/bin/gbrain`),
so the postinstall hook read the **half-resolved working tree** and tried to
parse a conflict marker as TypeScript. The accompanying
`spawnSync /bin/sh ETIMEDOUT` on `backfill_links` at ~62% of 5723 pages is the
same run starving under merge-time load.

> Running `bun install` mid-merge points the installed CLI at a tree containing
> conflict markers. Refresh the lockfile *after* the resolution is committed, or
> accept that the postinstall's migration attempts are garbage.

## Remedy (supervised, not run here)

`--force-retry` writes a `retry` marker, which resets the consecutive-partial
count:

```bash
gbrain apply-migrations --force-retry 0.11.0
gbrain apply-migrations --force-retry 0.12.0
```

Both cause the version to be re-attempted against the live brain. Expect
v0.12.0 to now succeed (its only failure was the conflict-marker artifact) and
v0.11.0 to surface the `public.pages` leak again, since nothing in this sync
addresses it.
