# Pace Mode (DB-contention-aware backfill pacing)

A naive `gbrain embed --stale` / large `sync` can saturate a PgBouncer
transaction-mode pooler and starve the minion supervisor's lock renewals
(`lock-renewal-failed` → dead jobs). Pacing is the native, composable fix — it
replaces external SIGSTOP/SIGCONT wrapper scripts. **Opt-in: default mode
`off`.**

## The primitive

The composable primitive is `src/core/db-pacer.ts` (`createDbPacer`):

- **Concurrency cap is the real lever** (caps simultaneous in-flight DB writes
  = pooler slots held). Embed paths set their worker count to `maxConcurrency`
  (single pool, no permit); `sync` uses the shared `acquire()` **permit**
  because each parallel worker owns a separate engine (one budget must span
  pools).
- **In-band signal** (`observe(ms)` EWMA from the work's own queries — never
  blind the way an out-of-band probe pool would be). **No probe loop, no
  `probeLatency` engine method.**
- **Cooperative `pace()` sleep** on `setTimeout` (keeps the lock heartbeat
  firing), jittered to avoid a thundering-herd resume. `acquire()`/`pace()`
  throw `AbortError` on cancel; everything else is fail-open (a pacer bug never
  kills a backfill, never throws an unhandledRejection).

## Mode bundles and resolution

Named bundles resolve through `src/core/pace-mode.ts` (`resolvePaceMode`), a
mirror of the search-mode pattern but with **env ABOVE config** (incident
escape hatch):

    per-call flag → GBRAIN_PACE_* env → config (pace.*) → PACE_BUNDLES[mode] → off

| Knob | off | gentle | balanced | aggressive |
|---|---|---|---|---|
| `maxConcurrency` | (off) | 4 | 8 | 16 |
| `paceAtMs` (EWMA → sleep) | — | 250 | 500 | 1000 |
| `maxSleepMs` (jittered cap) | — | 2000 | 1500 | 1000 |

## Surfaces

`gbrain embed --stale --pace[=mode]` (bare `--pace` = balanced),
`--pace-max-concurrency=N`. `--background` carries explicit pace OVERRIDES (not
the resolved bundle) into the `embed` job payload; the handler re-resolves
env>config>bundle at execution so `GBRAIN_PACE_*` still wins. Config-level
`pace.mode` paces EVERY `runEmbedCore` caller (cycle embed, embed-catch-up,
sync-auto-embed) and the prod `embed-backfill` job automatically. `sync` reads
env/config. PGLite / mode `off` → no-op pacer.

## Correctness coupled to pacing

Longer paced runs widen these windows, so the fixes ship with the pacer:

- CLI `embed --stale` single-flights via the SAME per-source lock key as the
  `embed-backfill` handler (`src/core/embed-backfill-lock.ts`; all-source runs
  lock every source in sorted order) so a hand-run backfill and a queued job
  can't race the NULL→non-NULL upsert.
- A **bounded** end-of-run keyset re-entry (max 3 passes + forward-progress
  requirement, paced runs only) catches rows inserted behind the cursor.
- The embed wall-clock budget timer is re-armed around `pace()` sleeps so paced
  time doesn't burn the work budget.

## Telemetry

`EmbedResult.pacing` carries the end-of-run telemetry (cap, samples, EWMA,
slept ms, max waiters) for `--json`; a one-line summary prints to stderr.

## Related

- [docs/operations/sync-tuning.md](sync-tuning.md) — sync resumability +
  lock-tuning env knobs (the other half of contention control).
- [docs/guides/queue-operations-runbook.md](../guides/queue-operations-runbook.md)
  — diagnosing dead jobs and lock-renewal failures.
- `src/core/db-pacer.ts`, `src/core/pace-mode.ts` entries in
  [docs/architecture/KEY_FILES.md](../architecture/KEY_FILES.md).
