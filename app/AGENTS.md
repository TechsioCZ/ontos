# OntOS application guardrails

Before touching files under `app/`, read [the application coding guide](./README.md). It owns the
minimum setup and validation workflow and routes each concern to one focused implementation
document.

Use [`.env.example`](./.env.example) and repository environment scripts to understand configuration.
Do not open, print, or quote any `.env` file contents.

## Specifications

Read only the specification explicitly named by the task or GitHub issue. Do not browse
`app/specs/` for context.

- `planned` and `in_progress` specifications may define the named change scope.
- `done`, `complete`, and `superseded` specifications are historical evidence. Stop unless the task
  explicitly requests provenance.

## Stop conditions before editing

- Discover supported business generators from the `scaffold:*` scripts in [`package.json`](./package.json)
  and inspect the selected command with `--help`. Generated output is the required starting point.
  If the required artifact has no approved generator or governed gateway, stop and get that
  boundary approved.
- Never import another deployment's private source, runtime registration, data access, or executable
  behavior. Resolve the public MicroVertical contract instead.
- Run repository pnpm commands from `app/` through `mise exec -- pnpm`.

All remaining rules belong to the coding guide and the single task-specific document it selects.
