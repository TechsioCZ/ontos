# TERP Architecture Pack v3 — `/grill-with-docs` input

This pack is a working architecture dossier for TERP. It is intentionally written as input for a technical architecture grilling session and for a coding agent. It consolidates the current business context, delivery constraints, architectural decisions, MicroVertical semantics, C4 views, ADRs, glossary, V0 scope, roadmap, and open questions.

The most important correction in this version is the MicroVertical model. A TERP MicroVertical is not a frontend module plus a separate BFF/backend service. A MicroVertical is a unified vertical slice inside one jointly deployable UltraModern.js application. It owns its UI, routes, state, actions, command handlers, domain tables, entity declarations, relation declarations, migrations, tests, and projection descriptors. The TERP Core sits alongside the MicroVerticals as system infrastructure: authentication integration, authorization adapter, module runtime, entity registry, relation registry, audit, events, outbox, documents, search, and projection interfaces.

## Recommended reading order

1. `00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md` — give this to the grilling/coding agent first.
2. `01_CONTEXT_AND_CONSTRAINTS.md` — why this exists, what must be delivered, what is out of scope.
3. `02_GLOSSARY.md` — precise vocabulary; this should be grilled aggressively.
4. `03_ARCHITECTURE_OVERVIEW.md` — coherent high-level architecture.
5. `04_C4_MODEL.md` — C4 context/container/component views adapted to MicroVertical reality.
6. `05_MICROVERTICALS.md` — exact MicroVertical semantics, lifecycle, boundaries, and runtime behavior.
7. `06_CORE_KERNEL.md` — what belongs in Core and what must stay out.
8. `07_RUNTIME_CONSISTENCY_MODEL.md` — actions, commands, audit, events, outbox, workers.
9. `08_CANONICAL_ENTITY_MODEL.md` — domain tables, entity registry, relation types, Neo4j projection.
10. `09_AUTHN_AUTHZ_MODEL.md` — BetterAuth, SpiceDB, TERP policy layer.
11. `10_DATA_STORAGE_AND_PROJECTIONS.md` — Postgres, Neo4j, search, object storage, projection lag.
12. `11_V0_SCOPE_AND_MODULES.md` — concrete V0 functional scope and modules.
13. `12_ROADMAP.md` — May PoC, June decisions, July–December 2026, 2027 business roadmap.
14. `13_GRILL_QUESTIONS.md` — questions the agent should use to challenge the architecture.
15. `adr/` — decision records. These are proposed decisions, not sacred law.
16. `diagrams/` — Mermaid source diagrams. They are separate so the prose stays readable.
17. `appendix/` — source grounding and evidence notes.

## Core thesis

TERP V0 is a delivery-bound ERP system implemented as a TypeScript modular monolith built on UltraModern.js MicroVerticals. The long-term direction is a temporal company ontology system, but V0 must first deliver concrete ERP functionality: multi-company structure, property registry, long-term rental, short-term rental, billing, accounting handoff, documents, permissions, audit, and reporting.

The architecture optimizes for a small team, heavy coding-agent usage, fast prototyping, production delivery by the end of 2026, and future extensibility without premature distributed-systems complexity.
