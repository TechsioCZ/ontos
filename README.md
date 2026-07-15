# OntOS Architecture Pack v3 — `/grill-with-docs` input

This pack is a working architecture dossier for OntOS. It is intentionally written as input for a technical architecture grilling session and for a coding agent. It consolidates the current business context, delivery constraints, architectural decisions, MicroVertical semantics, C4 views, ADRs, glossary, V0 preparation scope, V1 delivery scope, roadmap, and open questions.

The most important correction in this version is the MicroVertical model. An UltraModern.js MicroVertical is not a frontend module plus a separate BFF/backend service. It is a unified vertical slice inside one jointly deployable UltraModern.js application. OntOS uses that implementation concept for ERP business modules, then adds an OntOS-specific Effect Schema-defined Module Manifest for public module contracts: activation, dependencies, public APIs, public components, public resource types, public events, search, and reports. The OntOS Core sits alongside the MicroVerticals as system infrastructure: BetterAuth binding, authorization adapter, tenant-level module state, action invocation recording, audit, events, outbox, media assets/links, search, ResourceRef conventions, and projection interfaces.

## Techsio UI Kit agent plugin

Ontos consumes `@techsio/ui-kit` from npm. Its agent guidance is distributed separately as the `techsio-ui-kit-ai` Codex plugin and is pinned in the repository marketplace at `.agents/plugins/marketplace.json`; it is not an npm dependency.

Each developer must install the plugin into their local Codex configuration after cloning the repository or after the pinned plugin revision changes:

```sh
# Required only for developers who do not already have GitHub HTTPS authentication configured.
gh auth status
gh auth setup-git

# Run from the Ontos repository root.
codex plugin marketplace add .
codex plugin list --available --marketplace ontos
codex plugin add techsio-ui-kit-ai@ontos
```

Restart the Codex app, or start a new CLI/IDE task, after installation. Verify the plugin with `codex plugin list` and `/skills`; consumer work should expose and use `$ui-component-usage` plus the matching component usage skill.

The bundled Context7, Figma, and Chrome DevTools MCP integrations are optional for consumer work. Figma-dependent workflows may ask each developer to complete user-local authorization on first use; `$ui-component-usage` does not require Figma or Chrome DevTools.

The upstream plugin also bundles two hooks for developing the UI kit in its source repository. They are not applicable to this npm consumer and its `SessionStart` hook would install a Git `pre-push` hook. Codex leaves plugin hooks untrusted by default: when `/hooks` reports them, leave both `techsio-ui-kit-ai` hooks untrusted or explicitly disable them. Do not use `--dangerously-bypass-hook-trust` with this plugin in Ontos.

The bundled Codex subagent TOML files are also aimed at UI-kit maintainers and are not installed automatically. Ontos consumers do not need to copy them into `.codex/agents`.

To reinstall after this repository updates the pinned plugin revision, or to remove it:

```sh
codex plugin remove techsio-ui-kit-ai@ontos
codex plugin add techsio-ui-kit-ai@ontos

# Remove only:
codex plugin remove techsio-ui-kit-ai@ontos
```

## Recommended reading order

1. `18_BUSINESS_SALES_VALUE_BRIEF.md` — business/sales value brief explaining customer pain, benefits, positioning, and proof points.
2. `17_DELIVERY_MANAGER_PRODUCT_LEAD_BRIEF.md` — short stakeholder brief explaining what happened this week and what Product/Delivery should help with.
3. `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md` — current operational handoff for June, including V0/V1 terminology correction, Core/Shell decision, PoC plan, and next-week developer tasks.
4. `15_PRE_DEVELOPMENT_VALIDATION_REPORT.md` — consolidated readiness audit and blocker list.
5. `00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md` — original grilling/coding-agent brief.
6. `01_CONTEXT_AND_CONSTRAINTS.md` — why this exists, what must be delivered, what is out of scope.
7. `02_GLOSSARY.md` — precise vocabulary; this should be grilled aggressively.
8. `03_ARCHITECTURE_OVERVIEW.md` — coherent high-level architecture.
9. `04_C4_MODEL.md` — C4 context/container/component views adapted to MicroVertical reality.
10. `05_MICROVERTICALS.md` — exact MicroVertical semantics, lifecycle, boundaries, and runtime behavior.
11. `06_CORE_KERNEL.md` — what belongs in Core and what must stay out.
12. `07_RUNTIME_CONSISTENCY_MODEL.md` — actions, commands, audit, events, outbox, workers.
13. `08_CANONICAL_ENTITY_MODEL.md` — explicit domain tables, ResourceRef, module ownership, Neo4j projection.
14. `09_AUTHN_AUTHZ_MODEL.md` — BetterAuth, SpiceDB, OntOS Policy Layer.
15. `10_DATA_STORAGE_AND_PROJECTIONS.md` — Postgres, Neo4j, search, object storage, projection lag.
16. `11_V0_SCOPE_AND_MODULES.md` — older V0 wording for functional scope; read with the V0/V1 correction in `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`.
17. `12_ROADMAP.md` — May PoC, June decisions, July–December 2026, 2027 business roadmap; read with the V0/V1 correction.
18. `13_GRILL_QUESTIONS.md` — questions the agent should use to challenge the architecture.
19. `14_ONTOS_MODULE_MANIFEST.md` — first Effect Schema-defined contract shape for OntOS Module Manifests.
20. `22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md` — requirements for the fresh `mvp2/` CoreSDK/OperationalContext experiment.
21. `adr/` — decision records. These are proposed decisions, not sacred law.
22. `diagrams/` — Mermaid Markdown diagrams. They are separate so the prose stays readable and can be previewed in VS Code.
23. `appendix/` — source grounding and evidence notes.

## Core thesis

OntOS V0 is the preparation and foundation phase: Core implementation, architecture, ADRs, docs, PoC, contracts, and delivery controls. OntOS V1 is the mandatory end-of-2026 ERP delivery implemented as a TypeScript modular monolith built on UltraModern.js MicroVerticals.

The architecture optimizes for a small team, heavy coding-agent usage, fast prototyping, V1 production delivery by the end of 2026, and future extensibility without premature distributed-systems complexity.
