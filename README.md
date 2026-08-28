# OntOS Architecture Pack v3 — `/grill-with-docs` input

This pack is a working architecture dossier for OntOS. Its documents are collected in [`docs/`](docs/). It is intentionally written as input for a technical architecture grilling session and for a coding agent. It consolidates the current business context, delivery constraints, architectural decisions, MicroVertical semantics, C4 views, ADRs, glossary, V0 preparation scope, V1 delivery scope, roadmap, and open questions.

The most important correction in this version is the MicroVertical model. An UltraModern.js MicroVertical is a unified full-stack slice behind a strict independently deployable seam. Each OntOS Foundational or Business Module owns its executable implementation and data lifecycle inside one MicroVertical delivery unit. Co-location is a Deployment Topology choice, never permission to import private registrations, share repositories or business transactions, or bypass published typed clients, Outbox contracts, and Shell/Core gateways. The replacement decision is recorded in [`ADR-0016`](docs/adr/0016-independently-deployable-microverticals.md).

## Recommended reading order

1. [`18_BUSINESS_SALES_VALUE_BRIEF.md`](docs/18_BUSINESS_SALES_VALUE_BRIEF.md) — business/sales value brief explaining customer pain, benefits, positioning, and proof points.
2. [`17_DELIVERY_MANAGER_PRODUCT_LEAD_BRIEF.md`](docs/17_DELIVERY_MANAGER_PRODUCT_LEAD_BRIEF.md) — short stakeholder brief explaining what happened this week and what Product/Delivery should help with.
3. [`16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`](docs/16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md) — current operational handoff for June, including V0/V1 terminology correction, Core/Shell decision, PoC plan, and next-week developer tasks.
4. [`15_PRE_DEVELOPMENT_VALIDATION_REPORT.md`](docs/15_PRE_DEVELOPMENT_VALIDATION_REPORT.md) — consolidated readiness audit and blocker list.
5. [`00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md`](docs/00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md) — original grilling/coding-agent brief.
6. [`01_CONTEXT_AND_CONSTRAINTS.md`](docs/01_CONTEXT_AND_CONSTRAINTS.md) — why this exists, what must be delivered, what is out of scope.
7. [`02_GLOSSARY.md`](docs/02_GLOSSARY.md) — precise vocabulary; this should be grilled aggressively.
8. [`03_ARCHITECTURE_OVERVIEW.md`](docs/03_ARCHITECTURE_OVERVIEW.md) — coherent high-level architecture.
9. [`04_C4_MODEL.md`](docs/04_C4_MODEL.md) — C4 context/container/component views adapted to MicroVertical reality.
10. [`05_MICROVERTICALS.md`](docs/05_MICROVERTICALS.md) — exact MicroVertical semantics, lifecycle, boundaries, and runtime behavior.
11. [`06_CORE_KERNEL.md`](docs/06_CORE_KERNEL.md) — what belongs in Core and what must stay out.
12. [`07_RUNTIME_CONSISTENCY_MODEL.md`](docs/07_RUNTIME_CONSISTENCY_MODEL.md) — actions, commands, audit, events, outbox, workers.
13. [`08_CANONICAL_ENTITY_MODEL.md`](docs/08_CANONICAL_ENTITY_MODEL.md) — explicit domain tables, ResourceRef, module ownership, Neo4j projection.
14. [`09_AUTHN_AUTHZ_MODEL.md`](docs/09_AUTHN_AUTHZ_MODEL.md) — BetterAuth, SpiceDB, OntOS Policy Layer.
15. [`10_DATA_STORAGE_AND_PROJECTIONS.md`](docs/10_DATA_STORAGE_AND_PROJECTIONS.md) — Postgres, Neo4j, search, object storage, projection lag.
16. [`11_V0_SCOPE_AND_MODULES.md`](docs/11_V0_SCOPE_AND_MODULES.md) — older V0 wording for functional scope; read with the V0/V1 correction in [`16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`](docs/16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md).
17. [`12_ROADMAP.md`](docs/12_ROADMAP.md) — May PoC, June decisions, July–December 2026, 2027 business roadmap; read with the V0/V1 correction.
18. [`13_GRILL_QUESTIONS.md`](docs/13_GRILL_QUESTIONS.md) — questions the agent should use to challenge the architecture.
19. [`14_ONTOS_MODULE_MANIFEST.md`](docs/14_ONTOS_MODULE_MANIFEST.md) — first Effect Schema-defined contract shape for OntOS Module Manifests.
20. [`22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md`](docs/22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md) — requirements for the fresh `mvp2/` CoreSDK/OperationalContext experiment.
21. [`docs/adr/`](docs/adr/) — decision records. These are proposed decisions, not sacred law.
22. [`docs/diagrams/`](docs/diagrams/) — Mermaid Markdown diagrams. They are separate so the prose stays readable and can be previewed in VS Code.
23. [`docs/appendix/`](docs/appendix/) — source grounding and evidence notes.

## Core thesis

OntOS V0 is the preparation and foundation phase: Core implementation, architecture, ADRs, docs, PoC, contracts, and delivery controls. OntOS V1 is the mandatory end-of-2026 ERP delivery composed from independently deployable TypeScript MicroVerticals. An Environment may co-locate delivery units, but placement never changes their contracts or ownership.

The architecture optimizes for a small team, heavy coding-agent usage, fast prototyping, V1 production delivery by the end of 2026, and future extensibility without premature distributed-systems complexity.
