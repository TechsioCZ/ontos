# OntOS

OntOS is a modular business product. Core and Shell provide shared runtime guarantees; cohesive
business capabilities live in independently deployable MicroVerticals and are assembled into
purpose-specific Application Compositions.

## Start here

- [Product](docs/PRODUCT.md) — current product scope and boundaries.
- [Documentation map](docs/README.md) — authority, reading routes, decisions, and diagrams.
- [Context map](CONTEXT-MAP.md) — select only the domain semantics and vocabulary relevant to the
  task.
- [Application coding guide](app/README.md) — setup, workspace routing, generators, and validation.
- [Application agent guardrails](app/AGENTS.md) — rules that apply before touching application
  files.

Use accepted [ADRs](docs/adr/README.md) for durable architectural decisions and the focused
documents under [`app/docs/`](app/docs/) for current implementation rules. Do not infer current
guidance from historical evidence or completed specifications.
