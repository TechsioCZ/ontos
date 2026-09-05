# OntOS application guardrails

Before changing files under `app/`, read [the application coding guide](./README.md). It owns
setup, generator commands, coding conventions, validation, and trigger-based links to focused
architecture.

Never read an `.env` file.

## Before editing

1. Read only the specification explicitly named by the task or GitHub issue. A specification with
   `status: done`, `status: complete`, or `status: superseded` is historical evidence; stop unless
   the task explicitly requests provenance.
2. Use the routing table in `README.md`. Open only documents whose concern matches the changed
   files or behavior, plus matching product contexts when semantics are relevant. Do not browse
   `app/specs/`, `app/docs/`, or root `docs/` for general background.
3. Start every supported business artifact with its Codesmith generator. If the category has no
   approved generator or governed gateway, stop and get that boundary approved.
4. Never import another deployment's private source, registration, data access, or executable
   behavior. If the task appears to require that, stop and resolve the MicroVertical contract.

All remaining coding and command rules are owned by `README.md` and the focused documents selected
by its routing table.
