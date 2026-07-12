# Sync conflict resolution records

Dated, append-only records of conflicts encountered while synchronizing this fork.
Use these records to understand prior choices before resolving the same area again.

## Filing rule

- Simple resolution: `YYYY-MM-DD-what-was-resolved.md`
- Complicated resolution with several files, alternatives, or supporting artifacts:
  `YYYY-MM-DD-what-was-resolved/` with a `README.md` entry point
- Record the refs merged, conflicted files, resolution chosen, verification run,
  and resulting commit.
- Never include credentials, private identifiers, or production data.

## Records

- [2026-07-12 upstream master into franky](2026-07-12-upstream-master-into-franky.md)
  — reconciled fork-specific embedding-provider documentation with upstream
  provider-agnostic gateway changes and restored the search-mode dashboard's
  query-embedding timeout entry.
