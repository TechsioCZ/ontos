# Agent instructions

- Application work belongs under `app/` and follows [`app/AGENTS.md`](app/AGENTS.md).
- Repository documentation work may change `README.md`, `CONTEXT-MAP.md`, `docs/`, and tracked
  documentation-routing skills under `.agents/skills/` when the task explicitly concerns
  documentation or agent discovery.
- Repository-root `.github/workflows/` may be changed when required for GitHub to discover and run
  the application's CI or deployment workflows.
- Closed GitHub issues are read-only. Do not edit, reopen, relabel, reassign, comment on, or otherwise
  modify closed issues.
- Open GitHub issues may go through product discovery, clarification, planning, and specification
  before execution-status labels are assigned. During this pre-execution phase, agents may analyze
  and refine issue bodies, scope, business rules, acceptance criteria, and related planning structure
  as needed to reach a correctly specified handoff. A missing `status:*` label is not a blocker for
  this discovery/specification work.
- Execution-status labels are assigned only after the relevant issues have been correctly specified
  and product-owner/HITL explicitly moves them into execution management. From that point, every
  execution-managed open issue must have exactly one of `status:now`, `status:park`,
  `status:tracking`, or `status:later`. That label is the authoritative execution gate and must
  be inspected before implementation or other execution-stage work. Missing or multiple
  execution-status labels at that stage require product-owner/HITL correction. Never change an
  execution-status label without explicit product-owner/HITL instruction.
- The `new-engine` repository is legacy. Use it only as optional historical or contextual reference;
  do not treat its code, architecture, or documentation as current guidance or a source of truth.
- For documentation authority and reading routes, follow [`docs/README.md`](docs/README.md). Do not
  treat completed specifications or historical evidence as current guidance unless the task asks
  for provenance.
