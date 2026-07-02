# Sync resumability + lock tuning

`gbrain sync` is resumable and converges under pool exhaustion and repeated
kills. Progress banks into the append-only `op_checkpoint_paths` table (one row
per drained path, written via the direct session pool so it survives
`EMAXCONNSESSION`); a killed run resumes from the checkpoint, and `last_commit`
only advances on true completion. The per-source lock heartbeats through the
direct pool and refuses to steal a live, recently-refreshed holder.

## Env knobs

Six env knobs tune it. All are env-only, incident-time escape hatches — no
config-dashboard surface by design:

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_SYNC_CHECKPOINT_EVERY` | 1000 | Flush the checkpoint every N drained files. |
| `GBRAIN_SYNC_CHECKPOINT_SECONDS` | 10 | Also flush every N seconds (whichever comes first) — bounds worst-case loss regardless of throughput. Flush also fires after the first file. |
| `GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES` | 3 | Consecutive failed flushes (each already retried ~12s) before the run aborts with `reason: 'checkpoint_unavailable'` instead of importing work it can never bank. |
| `GBRAIN_SYNC_YIELD_EVERY` | 64 | Yield the event loop (`setTimeout(0)`, NOT `setImmediate` — Bun starves the timers phase under a tight setImmediate loop) every N files so the lock-refresh `setInterval` heartbeat fires mid-import. |
| `GBRAIN_LOCK_STEAL_GRACE_SECONDS` | derived (~600 at 30min TTL) | A holder that refreshed within this window is NOT stolen even if its TTL lapsed (starved-but-alive). Dead holders stop refreshing, age past the grace, and become stealable; TTL stays the backstop. |
| `GBRAIN_SYNC_STALL_ABORT_SECONDS` | 900 | Progress-aware stall watchdog: if the import drain makes no forward progress (keyed on file-import progress, NOT the lock heartbeat) for N seconds, abort the run and release the per-source lock so the next `gbrain sync` resumes from the checkpoint. Reports `reason: 'stall_timeout'`. Observed BETWEEN files; a hang inside one file's import isn't interrupted until it returns (the wall-clock hard deadline is that backstop). 0 disables. |

## Related

- [docs/guides/live-sync.md](../guides/live-sync.md) — keeping the index
  current automatically (includes the Supabase direct-connection prerequisite
  that causes most "sync ran but nothing happened" reports).
- [docs/operations/pace-mode.md](pace-mode.md) — DB-contention-aware pacing for
  embed/sync backfills.
- [docs/guides/queue-operations-runbook.md](../guides/queue-operations-runbook.md)
  — queue/lock diagnostics.
