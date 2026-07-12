# Resolve upstream master into franky (2026-07-12)

## Context

The fork uses two remotes:

- `origin`: `https://github.com/frankji-groundcontrol/gbrain.git`
- `upstream`: `https://github.com/garrytan/gbrain.git` (fetch only; push URL disabled)

The sync path was:

```text
upstream/master -> origin/master -> origin/franky
```

`origin/master` was fast-forwarded to upstream commit `a25209bb`. That fork
branch was then merged into `franky`, producing merge commit `8a9aa131`.
Nothing was pushed to `upstream`.

## Conflict

`docs/architecture/KEY_FILES.md` had two content conflicts because `franky` and
upstream changed the same AI gateway documentation:

1. `src/core/ai/{dims,types,gateway}.ts`
2. `src/core/ai/build-gateway-config.ts`

The merge also exposed a TypeScript integration failure in
`src/commands/search.ts`: the fork had added `ModeBundle.query_embed_timeout_ms`,
but the exhaustive `KNOB_DESCRIPTIONS` map and the dashboard attribution list had
not added that key.

## Resolution

The documentation conflict kept both sides' current behavior:

- From `franky`: DashScope dimension validation, batch-item limits, API-key and
  base-URL plumbing, and the query-embedding timeout behavior.
- From upstream: `trust_custom_dims`, native provider base-URL normalization,
  empty environment values no longer overriding configured keys, and the
  corrected embedding-dimension diagnostic behavior.

The search dashboard gained the missing `query_embed_timeout_ms` description and
attribution entry. `test/commands-search.test.ts` now pins its JSON representation.

## Verification

The regression test was observed failing before the fix because
`report.resolved.query_embed_timeout_ms` was absent, then passing after the fix:

```text
17 pass
0 fail
```

`bun run typecheck` also exited successfully. The full `bun run verify` command
was offered but interrupted before execution, so this record does not claim that
gate passed.

Topology immediately after the sync merge was pushed:

```text
origin/master   a25209bb == upstream/master
origin/franky   8a9aa131 (15 commits ahead, 0 behind origin/master)
```

The documentation commit that added this record then advanced `origin/franky` to
`f3a2adf2` (16 commits ahead, 0 behind). These hashes are point-in-time receipts,
not a promise that the branch tips remain unchanged.
