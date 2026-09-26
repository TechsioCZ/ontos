# Agent instructions

- Application work belongs under `app/` and follows [`app/AGENTS.md`](app/AGENTS.md).
- Repository documentation work may change `README.md`, `CONTEXT-MAP.md`, `docs/`, and tracked
  documentation-routing skills under `.agents/skills/` when the task explicitly concerns
  documentation or agent discovery.
- Repository-root `.github/workflows/` may be changed when required for GitHub to discover and run
  the application's CI or deployment workflows.
- Closed GitHub issues are read-only. Do not edit, reopen, relabel, reassign, comment on, or otherwise
  modify closed issues.
- For execution-managed GitHub issue trees, every open issue must have exactly one of
  `status:now`, `status:park`, `status:tracking`, or `status:later`. The execution-status label is
  the authoritative work gate and must be inspected before analysis, planning, implementation, or
  scope expansion. Missing or multiple execution-status labels require product-owner/HITL correction.
  Never change an execution-status label without explicit product-owner/HITL instruction.
- The `new-engine` repository is legacy. Use it only as optional historical or contextual reference;
  do not treat its code, architecture, or documentation as current guidance or a source of truth.
- For documentation authority and reading routes, follow [`docs/README.md`](docs/README.md). Do not
  treat completed specifications or historical evidence as current guidance unless the task asks
  for provenance.
