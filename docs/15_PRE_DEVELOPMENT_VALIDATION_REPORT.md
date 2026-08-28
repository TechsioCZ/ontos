# Pre-Development Validation Report

Date: 2026-06-04
Repository: `/Users/satan/work/ontos`
Branch: `main`

> **Historical validation notice (superseded 2026-08-28):** This report records the architecture review as it stood on 2026-06-04. Its modular-monolith, jointly deployed runtime, central executable-registration, and Core-managed migration/handler recommendations are not current architecture. [ADR-0016](adr/0016-independently-deployable-microverticals.md) and `app/docs/architecture/` govern the independently deployable, owner-local MicroVertical contract. Retain the findings below as provenance only.

## Post-Validation Terminology Update

After this report was written, the planning language was clarified:

- V0 is preparation: Core implementation, architecture, ADRs, docs, PoC, contracts, and delivery controls.
- V1 is the mandatory end-of-2026 ERP delivery.

Where this report says "V0 acceptance" or "V0 delivery," read it as the same unresolved readiness issue now applied to V1 delivery. The concrete blockers remain valid; the label changed.

## Verdict

Pause production development until the blocker list below is resolved.

The architecture thesis is coherent: OntOS V0 is a modular monolith with UltraModern.js MicroVerticals, registered Actions for writes, Postgres as canonical state, outbox-backed asynchronous side effects, SpiceDB for authorization, BetterAuth for authentication, ResourceRef values for cross-module references, and Neo4j as an optional projection.

The documentation is not yet build-ready. It is strong architecture-review material, but it does not yet define enough executable contracts, database constraints, module functions, acceptance criteria, or V0 cuts for safe implementation by a small team and coding agents.

## Validation Method

Six read-only subagent lanes reviewed independent surfaces:

1. Architecture, C4, Core/MicroVertical boundary, roadmap, and scope.
2. Database schema, storage, ResourceRef, audit, outbox, media, evidence, and projections.
3. Authentication, authorization, policy, SpiceDB, principal resolution, and read evidence.
4. OntOS Module Manifest, actions/APIs, activation, dependencies, search, reports, and enforcement.
5. Diagrams and terminology consistency.
6. Delivery readiness, function planning, acceptance criteria, and scope realism.

The final findings below are deduplicated and checked against primary repo files.

## What Is Sound

- The modular-monolith direction is consistent across `03_ARCHITECTURE_OVERVIEW.md`, `04_C4_MODEL.md`, `05_MICROVERTICALS.md`, and ADR-0001/0002.
- The action-first write model is correctly separated from event/outbox side effects in principle.
- Postgres canonical state plus optional Neo4j projection is the right direction for V0, provided Neo4j remains optional.
- SpiceDB is correctly scoped as authorization infrastructure, not the business ontology graph.
- ResourceRef as a value reference is a reasonable compromise if resource keys, resolver rules, and validation semantics are tightened before implementation.
- The docs correctly resist V0 scope creep around product AI, vibemodule, full manufacturing, predictive maintenance, full channel manager integrations, portals, and a full accounting engine.

## Blockers

### B1. No V0 acceptance matrix

The docs state that V0 must satisfy rental, billing, accounting export, documents, roles/permissions, audit, reporting, multi-company foundations, and handover evidence, but they do not define per-workflow pass/fail criteria.

Evidence:
- `00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md:23`
- `appendix/00_SOURCE_GROUNDING.md:15`
- `12_ROADMAP.md:45`

Required resolution:
- Create a V0 acceptance matrix with workflows, required functions, user roles, business data, expected audit/evidence, screenshots or artifacts, and UAT pass criteria.
- Tie each roadmap item to one or more acceptance rows.

### B2. PoC gates and ADR outcomes are unresolved

The roadmap says the End of May 2026 PoC should prove stack and boundaries, but as of 2026-06-04 the repo still has PoC acceptance questions open and no recorded PoC verdicts. Several load-bearing ADRs remain `Proposed`.

Evidence:
- `12_ROADMAP.md:5`
- `12_ROADMAP.md:7`
- `13_GRILL_QUESTIONS.md:83`
- `13_GRILL_QUESTIONS.md:85`
- `adr/0001-microverticals-are-unified-vertical-slices.md:3`
- `adr/0002-modular-monolith-for-v0.md:3`
- `adr/0003-action-driven-core-evented-side-effects.md:3`
- `adr/0008-module-activation-state-model.md:3`
- `adr/0009-postgres-outbox-idempotent-workers.md:3`
- `adr/0010-separate-business-ontology-and-authz-graph.md:3`

Required resolution:
- Add a PoC result note or ADR update stating what was proven, what was rejected, and what remains unproven.
- Accept, reject, or explicitly mark load-bearing ADRs as "accepted for implementation start."

### B3. Planned functions/actions are not enumerated per module

The docs require Actions, Command Handlers, public APIs, authz, idempotency, audit, module state checks, imports, exports, search, reports, and evidence policies, but no V0 module has an accepted function/action list.

Evidence:
- `02_GLOSSARY.md:55`
- `07_RUNTIME_CONSISTENCY_MODEL.md:86`
- `11_V0_SCOPE_AND_MODULES.md:13`
- `11_V0_SCOPE_AND_MODULES.md:53`
- `14_ONTOS_MODULE_MANIFEST.md:168`

Required resolution:
- For each V0 module, define a first-pass function matrix: action/API key, purpose, request schema, response shape, idempotency requirement, authz permission, policy checks, audit profile, domain events, outbox messages, evidence policy, and acceptance scenario.

### B4. Actions are required by architecture but absent from the manifest shape

The glossary says Actions are declared in the OntOS Module Manifest, but the manifest public surface lists API, components, resource types, events, search, and reports, with no actions field. If Actions are derived from Effect HttpApi values, that must be explicit.

Evidence:
- `02_GLOSSARY.md:55`
- `14_ONTOS_MODULE_MANIFEST.md:26`
- `14_ONTOS_MODULE_MANIFEST.md:103`
- `14_ONTOS_MODULE_MANIFEST.md:172`
- `diagrams/c4-L3-microvertical.md:6`

Required resolution:
- Decide whether Actions are a manifest section, a first-class descriptor derived from HttpApi, or a separate private action registry.
- Document how the action registry drives idempotency, authz, policy, audit, module state, evidence, and imports/integrations.

### B5. Manifest-public surface vs private implementation registries is unresolved

The manifest correctly excludes tables, migrations, command handler paths, route trees, outbox handler paths, and projection implementation details. But Core still needs explicit registration for migrations, actions, handlers, route/UI contribution guards, outbox handlers, projection handlers, search descriptors, and report descriptors. The non-public registry/catalog is not defined.

Evidence:
- `05_MICROVERTICALS.md:70`
- `06_CORE_KERNEL.md:43`
- `14_ONTOS_MODULE_MANIFEST.md:38`
- `14_ONTOS_MODULE_MANIFEST.md:53`
- `04_C4_MODEL.md:73`

Required resolution:
- Add a companion "module implementation contract" or "private module registry" spec separate from the public manifest.
- Define what every MicroVertical must provide before it is considered implementation-complete.

### B6. Activation semantics and persisted module states are inconsistent

The manifest uses `defaultState: "inactive"` and supports `deprecated`, while the ERD omits `inactive` and `deprecated`; the lifecycle diagram starts at `Active`. Activation behavior is also not defined per surface and state.

Evidence:
- `14_ONTOS_MODULE_MANIFEST.md:79`
- `14_ONTOS_MODULE_MANIFEST.md:80`
- `diagrams/core-db-resource-ref-v0.mmd:51`
- `diagrams/module-lifecycle.md:5`
- `adr/0008-module-activation-state-model.md:21`

Required resolution:
- Normalize the state enum across prose, manifest, ERD, and diagrams.
- Define the behavior matrix for active, inactive, read-only, suspended, quarantined, deprecated, and archived across reads, writes, UI contributions, routes, search, reports, public APIs, historical data, and workers.

### B7. Tenant isolation is not enforceable from the ERD

Many tables have both `tenant_id` and foreign keys, but the ERD does not state composite same-tenant constraints. A migration could permit tenant A rows pointing at tenant B principals, legal entities, auth bindings, media assets, actions, evidence, invoices, or child rows.

Evidence:
- `09_AUTHN_AUTHZ_MODEL.md:50`
- `09_AUTHN_AUTHZ_MODEL.md:52`
- `diagrams/core-db-resource-ref-v0.mmd:36`
- `diagrams/core-db-resource-ref-v0.mmd:72`
- `diagrams/core-db-resource-ref-v0.mmd:234`

Required resolution:
- Add composite unique keys on parent tables and composite FKs including `tenant_id`.
- Define same-tenant rules for legal entities, principals, auth bindings, action invocations, audit/data-access/domain events, evidence, media assets/links, invoices, invoice lines, and module-owned child tables.

### B8. Principal resolution order is unsafe for tenant-scoped auth bindings

The auth model says principal resolution happens before context resolution, but principal auth bindings are tenant-scoped. A BetterAuth user or API key with multiple tenant bindings could resolve ambiguously or trust an unverified tenant selector.

Evidence:
- `09_AUTHN_AUTHZ_MODEL.md:26`
- `09_AUTHN_AUTHZ_MODEL.md:64`
- `diagrams/core-db-resource-ref-v0.mmd:36`

Required resolution:
- Define the tenant selection and binding lookup algorithm explicitly.
- Decide whether provider subjects are globally bound to one principal, tenant-scoped principals are selected after verified tenant membership, or another model is used.
- Add fail-closed behavior for ambiguous tenant/principal resolution.

### B9. Idempotency is required but not backed by schema constraints

The docs require backend-authoritative idempotency for non-idempotent writes, but `CORE_ACTION_INVOCATIONS.idempotency_key` is nullable and no unique/locking constraint is specified.

Evidence:
- `07_RUNTIME_CONSISTENCY_MODEL.md:96`
- `07_RUNTIME_CONSISTENCY_MODEL.md:106`
- `07_RUNTIME_CONSISTENCY_MODEL.md:109`
- `diagrams/core-db-resource-ref-v0.mmd:82`

Required resolution:
- Define the exact idempotency scope and partial unique index.
- Specify request-hash conflict handling, replay behavior, running/pending behavior, failed retry policy, and system/import exceptions.

### B10. V0 source scope is not reconciled with planned cuts

The source grounding includes pricing, payments, service/energy settlement, CRM, communication templates, administration, integrations/API, and portals. V0 exclusions do not explicitly accept, defer, or cut several of these. The roadmap still compresses core platform, property, documents, rentals, billing, accounting, imports, UAT, and handover into June-December 2026 with roughly two FTE developers.

Evidence:
- `01_CONTEXT_AND_CONSTRAINTS.md:21`
- `appendix/00_SOURCE_GROUNDING.md:11`
- `11_V0_SCOPE_AND_MODULES.md:57`
- `12_ROADMAP.md:29`
- `12_ROADMAP.md:33`
- `13_GRILL_QUESTIONS.md:75`
- `13_GRILL_QUESTIONS.md:77`

Required resolution:
- Produce an explicit V0 cutline: committed, thin-slice, deferred, excluded.
- Include the minimum acceptable short-term rental, long-term rental, billing, accounting export, document, reporting, and permission workflows.

### B11. Property, Party/Contact/CRM, and external actor ownership is not resolved

`property.registry` is described as the dependency root but also as a working assumption with open boundaries. Rental modules need tenants/contacts/guests; accounting needs parties/suppliers; August includes contacts/CRM basics; no module owns shared Party/Contact/CRM primitives. The property ERD also implies a direct legal entity FK, while glossary/context say ownership and management assignments are temporal from day one.

Evidence:
- `11_V0_SCOPE_AND_MODULES.md:19`
- `11_V0_SCOPE_AND_MODULES.md:21`
- `11_V0_SCOPE_AND_MODULES.md:29`
- `11_V0_SCOPE_AND_MODULES.md:33`
- `13_GRILL_QUESTIONS.md:34`
- `02_GLOSSARY.md:129`
- `02_GLOSSARY.md:133`
- `CONTEXT.md:163`
- `diagrams/core-db-resource-ref-v0.mmd:294`

Required resolution:
- Decide the V0 owner for Party/Contact/CRM primitives.
- Define whether property legal-entity relation is current operating scope, ownership assignment, management assignment, or billing/reporting context.
- Add temporal assignment tables or explicitly defer them and adjust glossary/roadmap language.

### B12. Accounting/export handoff is not acceptance-ready

The docs correctly reject statutory accounting, but they do not define the target export format/system, export batch lifecycle, cost/supplier invoice fields, payment/reconciliation behavior, UAT evidence, or the boundary between receivables/payment state and accounting correctness.

Evidence:
- `11_V0_SCOPE_AND_MODULES.md:37`
- `11_V0_SCOPE_AND_MODULES.md:41`
- `11_V0_SCOPE_AND_MODULES.md:63`
- `13_GRILL_QUESTIONS.md:78`

Required resolution:
- Define "accounting handoff" as accepted V0 behavior: export targets, fields, lifecycle, evidence, failure/retry, import/reconciliation, and what is deliberately out of scope.

## Major Findings To Resolve Before Migrations Or Scaffolding

1. Neo4j is optional in constraints/roadmap but described as a normal runtime container in overview/C4. Make every Neo4j reference say optional projection unless explicitly discussing a spike. Evidence: `01_CONTEXT_AND_CONSTRAINTS.md:27`, `12_ROADMAP.md:7`, `03_ARCHITECTURE_OVERVIEW.md:17`, `04_C4_MODEL.md:31`.
2. Worker writes are an exception to "all writes through Actions" but no boundary is defined. Evidence: `03_ARCHITECTURE_OVERVIEW.md:9`, `04_C4_MODEL.md:81`, `06_CORE_KERNEL.md:49`.
3. ResourceRef identity is under-specified: stable `resource_type` and `resource_id` conventions, manifest allowlists, resolver rules, deletion semantics, and all-null/all-present checks are not defined. Evidence: `08_CANONICAL_ENTITY_MODEL.md:17`, `adr/0006-explicit-domain-tables-plus-resource-ref.md:27`, `14_ONTOS_MODULE_MANIFEST.md:238`.
4. Resource type examples conflict: one diagram uses `unit`, while the manifest example uses `property.unit`. Evidence: `diagrams/core-db-resource-ref-v0.html:1036`, `14_ONTOS_MODULE_MANIFEST.md:238`.
5. Search/list authorization requires SpiceDB filtering but ordinary records may not have SpiceDB tuples. The tuple/query strategy is unresolved. Evidence: `09_AUTHN_AUTHZ_MODEL.md:68`, `09_AUTHN_AUTHZ_MODEL.md:78`, `10_DATA_STORAGE_AND_PROJECTIONS.md:46`.
6. Role/access changes must fail closed if SpiceDB cannot update, but the transaction/order/source-of-truth model between Postgres actions and SpiceDB tuple writes is absent. Evidence: `09_AUTHN_AUTHZ_MODEL.md:80`, `10_DATA_STORAGE_AND_PROJECTIONS.md:19`, `07_RUNTIME_CONSISTENCY_MODEL.md:9`.
7. Authn failures do not fit the action/audit envelope because audit starts at `action.received`, while `CORE_ACTION_INVOCATIONS.principal_id` is non-null in the ERD. Evidence: `07_RUNTIME_CONSISTENCY_MODEL.md:58`, `diagrams/core-db-resource-ref-v0.mmd:74`.
8. Support impersonation leaves `auth_binding_id` ambiguous: target user's binding or original admin credential. Evidence: `09_AUTHN_AUTHZ_MODEL.md:42`, `07_RUNTIME_CONSISTENCY_MODEL.md:17`, `diagrams/core-db-resource-ref-v0.mmd:405`.
9. Data access events do not model denied reads/searches with outcome fields equivalent to audit events. Evidence: `09_AUTHN_AUTHZ_MODEL.md:68`, `diagrams/core-db-resource-ref-v0.mmd:124`, `diagrams/core-db-resource-ref-v0.mmd:103`.
10. Redacted read evidence lacks retention/classification/disposition fields or a link to evidence reference lifecycle. Evidence: `07_RUNTIME_CONSISTENCY_MODEL.md:183`, `07_RUNTIME_CONSISTENCY_MODEL.md:191`, `diagrams/core-db-resource-ref-v0.mmd:133`.
11. Domain event ordering is prose-only; the ERD does not show unique `(tenant_id, tenant_sequence_no)` or assignment mechanics. Evidence: `07_RUNTIME_CONSISTENCY_MODEL.md:42`, `diagrams/core-db-resource-ref-v0.mmd:151`.
12. Outbox delivery is under-modeled for claiming, retry, dead-letter, handler idempotency, and observability. Evidence: `adr/0009-postgres-outbox-idempotent-workers.md:11`, `04_C4_MODEL.md:73`, `diagrams/core-db-resource-ref-v0.mmd:155`.
13. Worker checkpoints have a first-run null cursor mismatch. Evidence: `07_RUNTIME_CONSISTENCY_MODEL.md:44`, `diagrams/core-db-resource-ref-v0.mmd:265`.
14. Evidence source constraints are documented but not represented in the ERD. Evidence: `07_RUNTIME_CONSISTENCY_MODEL.md:144`, `07_RUNTIME_CONSISTENCY_MODEL.md:172`, `diagrams/core-db-resource-ref-v0.mmd:203`.
15. Media asset storage identity conflicts with prose: prose says `storage_provider + storage_key`, ERD marks only `storage_key` unique. Evidence: `10_DATA_STORAGE_AND_PROJECTIONS.md:30`, `diagrams/core-db-resource-ref-v0.mmd:185`.
16. Search projection lacks uniqueness, source version/event sequence, indexed status, indexed timestamp, tombstone, and lag/rebuild metadata. Evidence: `10_DATA_STORAGE_AND_PROJECTIONS.md:44`, `10_DATA_STORAGE_AND_PROJECTIONS.md:50`, `10_DATA_STORAGE_AND_PROJECTIONS.md:54`, `diagrams/core-db-resource-ref-v0.mmd:247`.
17. Billing invoice number uniqueness is marked globally, but prose says real-world uniqueness is per legal entity. Evidence: `diagrams/core-db-resource-ref-v0.mmd:356`, `07_RUNTIME_CONSISTENCY_MODEL.md:118`.
18. `property.short_term_rental` says it covers units/spaces even though `property.registry` owns units/spaces. Evidence: `11_V0_SCOPE_AND_MODULES.md:19`, `11_V0_SCOPE_AND_MODULES.md:33`, `03_ARCHITECTURE_OVERVIEW.md:23`.
19. Internal dogfood promises draft invoices before billing is scheduled. Evidence: `11_V0_SCOPE_AND_MODULES.md:25`, `adr/0011-internal-dogfood-early.md:11`, `12_ROADMAP.md:25`, `12_ROADMAP.md:33`.
20. Organization Registry uses `parent/subsidiary` role names while prose rejects V0 ownership/control ledger semantics. Evidence: `diagrams/core-db-resource-ref-v0.mmd:286`, `diagrams/organization-registry-v0-group-view.mmd:5`, `08_CANONICAL_ENTITY_MODEL.md:59`, `CONTEXT.md:32`.

## Recommended Resolution Order

1. Create a V0 acceptance matrix and source-scope cutline.
2. Record PoC results and settle load-bearing ADR statuses.
3. Define the action/API/function descriptor contract, including idempotency, authz, policy, evidence, audit, events, and outbox.
4. Define the public manifest vs private implementation registry split.
5. Normalize module activation states and write the per-state behavior matrix.
6. Fix Core DB invariants before migrations: tenant composite FKs, idempotency uniqueness, event sequence uniqueness, evidence source checks, media storage identity, billing uniqueness, outbox claim fields, search projection metadata.
7. Resolve principal resolution, impersonation, SpiceDB tuple-write consistency, and search/list authorization strategy.
8. Resolve V0 module ownership for Property, Party/Contact/CRM, rentals, billing, accounting handoff, documents, reports, and internal dogfood.
9. Revise diagrams after the prose decisions are made, especially module lifecycle, ResourceRef examples, C4 Neo4j optionality, Organization Registry labels, and action flow transaction boundaries.
10. Only then start production scaffolding and migrations.

## Development Start Criteria

Production development is safe to start when these artifacts exist:

- Accepted V0 acceptance matrix.
- Accepted V0 source cutline.
- Accepted or implementation-start statuses for ADR-0001, 0002, 0003, 0008, 0009, 0010, and 0011.
- Core schema invariant checklist with explicit constraints/indexes.
- Action/API/function matrix for the foundation plus first customer-domain module.
- Module implementation "done" template.
- Module activation behavior matrix.
- Principal/authz/search/evidence consistency rules.
- Updated diagrams matching the prose.

Until then, only pre-development work should proceed: clarifying docs, updating ADRs, resolving schema contracts, and writing PoC/acceptance artifacts.
