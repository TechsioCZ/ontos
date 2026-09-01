# OntOS application guardrails

Before touching files under `app/`, read [the application coding guide](./README.md). It owns
setup, generator commands, coding conventions, validation, and links to task-specific architecture.

Never read an `.env` file.

## Specifications

Read only the specification explicitly named by the task or GitHub issue. Do not browse
`app/specs/` for context. A specification with `status: done`, `status: complete`, or
`status: superseded` is historical implementation evidence; stop unless the task explicitly
requests provenance.

## Stop conditions before editing

- A supported business artifact must start from its required Codesmith generator. If the category
  has no approved generator or governed gateway, stop and get that boundary approved first.
- A change must not import another deployment's private source, registration, data access, or
  executable behavior. If the task appears to require that, stop and resolve the MicroVertical
  contract instead.

All other coding and command rules are owned by [the application coding guide](./README.md) and the
task-specific document it selects.
