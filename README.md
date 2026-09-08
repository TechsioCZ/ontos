# OntOS

OntOS is a modular business product. Core and Shell provide shared runtime guarantees; cohesive
business capabilities live behind independently deployable MicroVertical seams and are assembled
into purpose-specific Application Compositions.

## Start here

- [Documentation map](docs/README.md) — authority, reading routes, decisions, and diagrams.
- [Context map](CONTEXT-MAP.md) — select every focused product context whose trigger materially
  matches the task; usually one, sometimes more.
- [Application coding guide](app/README.md) — setup, generators, coding rules, and validation.
- [Application agent guardrails](app/AGENTS.md) — rules that apply before touching application files.

Top-level product shape and boundaries live in [Product](docs/PRODUCT.md); focused contexts own
accepted domain semantics and vocabulary. Durable architecture lives in accepted
[ADRs](docs/adr/README.md). Current implementation mechanics live in the task-specific documents
routed through [`app/docs/`](app/docs/). Do not infer current guidance from old delivery plans or
completed implementation specifications.
