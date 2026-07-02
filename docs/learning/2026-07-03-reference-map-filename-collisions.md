# Reference-map rows can misroute on filename collisions

**Date:** 2026-07-03. **Scope:** any thin-router file (CLAUDE.md, AGENTS.md,
skills/RESOLVER.md) whose rows point at docs by path.

## What was learned

A router row can silently point at the wrong document when two docs share a
name. CLAUDE.md's reference map routed "search modes / cost knobs" to
`docs/guides/search-modes.md` — but that guide teaches which search *command*
to use (`search` vs `query` vs `get`). The named mode *bundles*
(conservative / balanced / tokenmax) had no doc at all; their only home was an
inline CLAUDE.md section, so the row looked correct by filename while routing
to the wrong topic. Agents following the map would read a plausible doc and
never notice the miss.

## Evidence

Found by the 2026-07-03 full-tree doc survey
([plan record](../plans/2026-07-03-clean-repo-org-docs-init.md)); fixed by
creating `docs/operations/search-modes.md` for the bundles, cross-linking both
docs to each other, and rewriting the row to name the distinction explicitly.

## When to apply again

- When adding a reference-map/resolver row, open the target and confirm it
  covers the row's topic — filename match is not evidence.
- When two docs must share a name, put a "different topic, similar name"
  callout at the top of each, pointing at the other.
- When an always-loaded router section is the *only* home for a topic, that is
  the smell: create the on-demand doc first, then row-point to it.
