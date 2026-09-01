# OntOS

OntOS is a modular business product. Core and Shell provide shared runtime guarantees; cohesive
business capabilities live in independently deployable MicroVerticals and are assembled into
purpose-specific application compositions.

## Start here

- [Documentation map](docs/README.md) — authority, reading routes, decisions, and diagrams.
- [Context map](CONTEXT-MAP.md) — choose only the domain vocabulary relevant to the task.
- [Application coding guide](app/README.md) — setup, generators, coding rules, and validation.
- [Application agent guardrails](app/AGENTS.md) — rules that apply before touching application files.

For architecture, use the accepted [ADRs](docs/adr/README.md). For implementation, use the
task-specific documents under [`app/docs/`](app/docs/). Do not infer current guidance from old
delivery plans or completed implementation specifications.
