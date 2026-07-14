# Issue records

Concrete implementation-issue write-ups and improvement backlogs that are
bigger than a `TODOS.md` line but not (yet) a design doc. Records here are
point-in-time: when the work ships, add a closing note at the top of the
record rather than silently deleting it.

Filed GitHub issues and the release-scoped follow-up channel
([`../../TODOS.md`](../../TODOS.md)) remain the canonical trackers; a record
here carries the analysis those trackers link to.

## Records

- [2026-07-13-dashscope-workspace-embedding-endpoint.md](2026-07-13-dashscope-workspace-embedding-endpoint.md)
  — workspace-native DashScope embeddings need a request/response adapter;
  model-override probes must preserve the configured provider URL.
- [2026-07-13-dashscope-vision-plus-multimodal.md](2026-07-13-dashscope-vision-plus-multimodal.md)
  — resolved native Vision Plus adapter and safe 1024d unified text-and-image
  rollout for DashScope workspaces.
- [cross-modal-search.md](cross-modal-search.md) — text↔image cross-modal
  search proposal. Phases 1–2 have since shipped (`cross_modal` routing +
  `search_by_image`).
- [doctor-auto-heal-and-scoring.md](doctor-auto-heal-and-scoring.md) — ranked
  backlog of `gbrain doctor` improvements; several items (remediation plan,
  temporal contradiction probe) have since shipped.
- [doc-drift-backlog.md](doc-drift-backlog.md) — documentation drift found by
  the 2026-07-03 full-tree survey, deferred for follow-up.
