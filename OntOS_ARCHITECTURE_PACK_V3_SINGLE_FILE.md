# OntOS Architecture Pack v3 — Single File

This file is a concatenation of the primary Markdown documents. Mermaid diagram sources are available in the ZIP under `diagrams/`.


---


<!-- Source file: README.md -->


# OntOS Architecture Pack v3 — `/grill-with-docs` input

This pack is a working architecture dossier for OntOS. It is intentionally written as input for a technical architecture grilling session and for a coding agent. It consolidates the current business context, delivery constraints, architectural decisions, MicroVertical semantics, C4 views, ADRs, glossary, V0 scope, roadmap, and open questions.

The most important correction in this version is the MicroVertical model. An OntOS MicroVertical is not a frontend module plus a separate BFF/backend service. A MicroVertical is a unified vertical slice inside one jointly deployable UltraModern.js application. It owns its UI, routes, state, actions, command handlers, domain tables, entity declarations, relation declarations, migrations, tests, and projection descriptors. The OntOS Core sits alongside the MicroVerticals as system infrastructure: authentication integration, authorization adapter, module runtime, entity registry, relation registry, audit, events, outbox, documents, search, and projection interfaces.

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
10. `09_AUTHN_AUTHZ_MODEL.md` — BetterAuth, SpiceDB, OntOS Policy Layer.
11. `10_DATA_STORAGE_AND_PROJECTIONS.md` — Postgres, Neo4j, search, object storage, projection lag.
12. `11_V0_SCOPE_AND_MODULES.md` — concrete V0 functional scope and modules.
13. `12_ROADMAP.md` — May PoC, June decisions, July–December 2026, 2027 business roadmap.
14. `13_GRILL_QUESTIONS.md` — questions the agent should use to challenge the architecture.
15. `adr/` — decision records. These are proposed decisions, not sacred law.
16. `diagrams/` — Mermaid source diagrams. They are separate so the prose stays readable.
17. `appendix/` — source grounding and evidence notes.

## Core thesis

OntOS V0 is a delivery-bound ERP system implemented as a TypeScript modular monolith built on UltraModern.js MicroVerticals. The long-term direction is a temporal company ontology system, but V0 must first deliver concrete ERP functionality: multi-company structure, property registry, long-term rental, short-term rental, billing, accounting handoff, documents, permissions, audit, and reporting.

The architecture optimizes for a small team, heavy coding-agent usage, fast prototyping, production delivery by the end of 2026, and future extensibility without premature distributed-systems complexity.

---


<!-- Source file: 00_AGENT_BRIEF_FOR_GRILL_WITH_DOCS.md -->


# Agent brief for `/grill-with-docs`

You are reviewing the OntOS architecture before implementation. Treat this as an architecture grilling session, not a documentation summarization task.

## Goal of the grilling session

The goal is to identify conceptual inconsistencies, missing definitions, invalid boundaries, overengineering, underengineering, performance risks, permission-model risks, migration risks, and delivery risks before the PoC and before the production V0 build.

The project will likely start with a throwaway PoC. The documents in this pack should help decide what the PoC must prove, what should be removed, and what must be nailed down before the June–December 2026 implementation window.

## Important correction to preserve

Do not model OntOS as a separate Web App container and BFF/API container where MicroVerticals live only in one of them. That is not the intended MicroVertical concept.

A MicroVertical is a unified vertical slice inside a jointly deployable UltraModern.js application. It includes frontend and backend concerns together: UI, routes, components, state, actions, command handlers, domain code, migrations, tests, and metadata. Core services are outside ordinary business MicroVerticals and provide the platform capabilities that all MicroVerticals use.

A separate worker runtime may exist for outbox processing, projections, imports, exports, and scheduled work. That does not make each MicroVertical a microservice. In V0 the system is a modular monolith/modulith.

## Constraints to respect

- Team capacity is roughly two FTE developers from June 2026, a partial product/UX/UI role, and heavy use of coding agents.
- Product AI is not part of V0 delivery. AI may be heavily used in development, but user-facing AI, autonomous agents, process autodiscovery, and vibemodule are later capabilities.
- The V0 must satisfy the 2026 ERP delivery obligation, including short-term rental, long-term rental, billing, accounting workflow/export, documents, roles/permissions, audit, reporting, and multi-company foundations.
- Internal dogfooding should begin early with clients, projects, tickets, documents, and invoice drafts.
- The current intended stack is UltraModern.js + MicroVerticals, existing design system, Postgres, SpiceDB, BetterAuth, and possibly Neo4j.
- Neo4j should be treated as an optional projection/read model, not assumed as mandatory V0 infrastructure or the canonical transactional ERP store.
- SpiceDB is foundation-level authorization infrastructure and should be challenged as the authorization graph, not the company ontology graph.
- Postgres should be challenged as canonical operational truth, but any alternative must explain billing, audit, exports, migrations, and committed delivery.

## What to grill first

1. Are MicroVertical boundaries defined precisely enough to implement and enforce?
2. Does the architecture correctly separate Core from MicroVerticals?
3. Is the action/command-driven state model sufficiently concrete?
4. Does the outbox/projection model avoid sync subscriber chaos?
5. Is the entity registry model a good compromise between explicit domain tables and global ontology?
6. Is the authorization model realistic for V0, especially SpiceDB consistency and search filtering?
7. Is Neo4j introduced at the right layer, or is it premature?
8. Does the V0 scope fit a two-developer team with coding agents?
9. Which parts should be cut from the PoC?
10. Which decisions must be converted into implementation tests or benchmarks?

## Expected output from the grilling agent

Produce a structured critique with: confirmed decisions, contested decisions, underdefined terms, risks, missing ADRs, proposed PoC experiments, and a revised implementation sequence. Avoid rewriting the architecture unless a decision is clearly invalid.

---


<!-- Source file: 01_CONTEXT_AND_CONSTRAINTS.md -->


# Context and constraints

OntOS is being shaped from a concrete customer delivery and a broader product opportunity. The immediate customer need is a committed ERP for a property/rental business context. The long-term product direction is a reusable ERP and company ontology platform that can serve the internal operator, the current customer’s multiple companies, and future larger customers.

## Delivery context

The customer delivery is framed as a new ERP system for a property/rental operator. The source material describes a company with insufficient software support, no internal system for managing the overall business agenda, and processes split between Booking.com, Excel, paper, and external administration/accounting. The intended outcome is a new ERP system that unifies agendas, improves process management, increases digitalization, and reduces manual error.

The draft module analysis expands that into a holding/asset/property management ERP: multiple SRO/SPV entities, property and unit registry, long-term rentals, short-term reservations, pricing, billing, payments, accounting exports, cost management, service/energy settlement, facility management, CRM, communication templates, document center, reporting, roles/permissions, administration, integrations/API, and future external portals.

The customer delivery materials create hard delivery constraints. The committed scope needs a working ERP by the end of 2026, with enough acceptance evidence to show that the delivered system supports the required business workflows. Delivery documentation will matter: scope evidence, acceptance records, handover materials, operational documentation, and audit-ready records.

## Product context

The broader OntOS ambition is not to write a one-off ERP for one customer. The intended long-term category is a temporal company ontology system with ERP MicroVerticals as the first application layer. Important business objects should be addressable entities; relationships should be typed, auditable, and time-aware; and future modules should be easier to add because they plug into the same Core.

This long-term direction must not distort V0. V0 is not the vibemodule, not an AI assistant, not an autonomous-agent platform, and not a full manufacturing/machine-prediction system. V0 must first prove that the Core and MicroVertical architecture can deliver concrete ERP functionality without becoming a fragile bespoke system.

## Team and execution constraints

The near-term implementation capacity is small: one founder prototyping in May/June, a second developer joining fully in June, partial product/UX/UI support, and heavy use of coding agents. That capacity rules out a distributed microservice architecture, a custom workflow engine, a user-facing no-code platform, and deep AI product features in V0.

Heavy coding-agent usage changes implementation throughput but does not remove the need for strong architecture. It increases the importance of precise vocabulary, module boundaries, action conventions, tests, generated scaffolds, and reviewable ADRs. Agents can generate code quickly; they can also generate a large amount of inconsistent code quickly if the architecture is underspecified.

## Current intended stack

The intended PoC stack is UltraModern.js with MicroVerticals, an existing design system, Postgres, SpiceDB, BetterAuth, and possibly Neo4j. This is not yet a final architecture. The PoC should validate the combination and reveal which parts are overkill, unsafe, or misaligned.

The stack division is currently understood as follows. UltraModern.js provides the unified application runtime and MicroVertical structure. The design system provides UI consistency. Postgres is canonical operational storage. SpiceDB is the authorization graph. BetterAuth is authentication/session DX. Neo4j may be added as a graph projection/read model for ontology exploration and relationship traversal once typed relations justify it.

## V0 non-goals

The following are deliberately not V0 product scope: user-facing AI assistant, autonomous agents, document AI automation, process autodiscovery, vibemodule as a user feature, full manufacturing ERP, machine/PLC integrations, predictive maintenance, full channel manager integrations, portals, and a general low-code builder.

Some of those capabilities must be prepared for architecturally. For example, actions should later be callable by agents, entity relationships should later support AI context, and MicroVertical manifests should later feed a module generator. Preparation does not mean implementation in V0.

---


<!-- Source file: 02_GLOSSARY.md -->


# Glossary

This glossary is part of the architecture. Terms should not be treated as cosmetic. If two people use the same word differently, the architecture will drift.

## OntOS

OntOS is the canonical name for the system. In V0 it is a delivery-bound ERP with platform-shaped foundations. In the long-term vision it becomes a temporal company ontology system with ERP MicroVerticals as the first application layer.

## OntOS Core

OntOS Core is the set of system capabilities that ordinary business MicroVerticals depend on. It is not itself a business MicroVertical. It includes authentication integration, principal context, authorization adapter, policy layer, module runtime, entity registry, relation registry, audit, events, outbox, document metadata services, search interfaces, reporting foundations, and projection interfaces.

Core is not meant to be disabled per tenant in the same way business MicroVerticals can be. Some Core capabilities may have configuration or feature flags, but the kernel-level concepts are part of the runtime contract.

## MicroVertical

A MicroVertical is a unified vertical slice of business capability inside the jointly deployable OntOS application. A MicroVertical contains its frontend and backend parts together: routes, screens, components, state, actions, command handlers, domain model, migrations, tests, fixtures, entity declarations, relation declarations, permissions, report descriptors, search descriptors, and projection descriptors.

A MicroVertical is not a microservice in V0. It is a module boundary inside a modular monolith. Its purpose is to keep domain slices cohesive and independently understandable without introducing distributed-system overhead.

Examples: `internal.delivery`, `property.registry`, `property.long_term_rental`, `property.short_term_rental`, `billing.core`, `accounting.office`, `documents.center`, `facility.basic`.

## System Module

A System Module is a Core capability described with a manifest-like structure for consistency, but it is not an ordinary business MicroVertical. Examples include `core.identity`, `core.authz`, `core.modules`, `core.ontology`, `core.audit`, `core.events`, `core.outbox`, and `core.search`.

## Module Manifest

A Module Manifest is the declarative contract of a MicroVertical or System Module. It declares module identity, version, dependencies, owned entity types, relation types, actions, permissions, UI contributions, migrations, report descriptors, search descriptors, and projection handlers. The manifest is the primary artifact that allows the runtime, tooling, coding agents, and later Forge/vibemodule functionality to reason about a module.

## OntOS Application Runtime

The OntOS Application Runtime is the main deployable application container. It includes the app shell, MicroVertical UI, server-side module actions, command handlers, Core services, and HTTP/API entrypoints. It should not be modeled as a separate Web App plus BFF for architecture purposes, because MicroVerticals intentionally combine frontend and backend concerns into a single vertical slice.

## OntOS Worker Runtime

The OntOS Worker Runtime is a separate process or set of processes for asynchronous work: outbox processing, Neo4j projections, search projections, reporting refreshes, import/export tasks, scheduled jobs, and future integration workers. It consumes events/outbox messages emitted by the application runtime. It should not own canonical business state except for controlled state transitions related to its work, such as marking an export as completed.

## Action

An Action is the public business operation exposed by a MicroVertical. It is the unit that UI, API calls, imports, integrations, and later agents invoke. Actions are declared in the module manifest and are subject to authentication, authorization, policy checks, module state checks, validation, audit, and command handling.

Examples: create reservation, issue invoice, attach document, link entities, activate module, create lease contract, create ticket.

## Command Handler

A Command Handler is the implementation of an Action. It performs validation and writes canonical state in Postgres in a transaction. It also records audit events, domain events, and outbox messages as part of the same transactional boundary.

## Domain Event

A Domain Event records a business fact that already happened. It is not the primary mechanism for changing business state. Domain events are used to explain history and trigger asynchronous projections or follow-up work.

## Audit Event

An Audit Event records who or what did something, when, under which principal, from which context, and why it was allowed or denied. Audit events are evidence. They should not be used as workflow triggers.

## Outbox Message

An Outbox Message is a delivery mechanism for asynchronous side effects. It is written in the same Postgres transaction as the business state change and later processed by workers. This avoids dual-write inconsistency between the database and external side effects.

## Entity

An Entity is a business object with durable identity over time. Full entities are addressable, searchable, linkable, auditable, and visible as first-class objects in the company ontology. Not every database row is an Entity.

## Entity Registry

The Entity Registry is a central addressability layer over explicit domain tables. It does not replace domain tables. It records stable entity identity, entity type, module ownership, display name, status, storage binding, and other metadata needed for linking, search, audit, and graph projection.

## Entity Reference

An Entity Reference is the stable reference used for cross-module linking. It should include tenant scope, entity type, and stable entity id. It should not expose arbitrary physical table names as the external linking contract.

## Relation Type

A Relation Type defines the semantics and constraints of a relationship between two entity types. It defines allowed source and target types, cardinality, temporal behavior, timeline visibility, search behavior, module ownership, and possibly permission implications.

## Entity Edge

An Entity Edge is a concrete typed relation between two entity references. Edges may be temporal and audit-backed. The edge table is the canonical relation store in Postgres; Neo4j receives a projection of it.

## Canonical Store

The Canonical Store is the source of truth for operational ERP state. For V0 this is Postgres. Neo4j, search indexes, and reports are projections/read models.

## Projection

A Projection is derived state built from canonical state and events. Neo4j graph nodes/relationships, search documents, reporting aggregates, and entity cards are projections. A projection must be rebuildable.

## Tenant

A Tenant is the top-level isolation boundary for a customer or internal operating environment. Cross-tenant access should be forbidden by default.

## Legal Entity

A Legal Entity is a managed accounting or operating company inside a tenant. It may own, operate, bill, report, or account for parts of the business. External organizations are Parties unless the tenant manages them as part of its own operating structure.

## Party

A Party is a real-world person or organization OntOS deals with. A Party may be a guest, tenant, supplier, accountant office, external management company, owned company, contact person, or commercial counterparty.

## Counterparty

A Counterparty is a Party in a commercial or contractual relationship with a managed Legal Entity. Counterparties can include tenants, guests, suppliers, external managers, corporate buyers, wholesalers, or accounting offices.

## Principal

A Principal is an actor that can authenticate, invoke actions, or appear in audit and authorization: internal staff, external manager staff, accountants, guests with portal access, integrations, service accounts, agents, or the system itself. In V0 agent principals may exist as foundations, but autonomous agent behavior is not product scope.

## External Operator

An External Operator is a Party outside the tenant's managed legal-entity structure that receives scoped operational access, such as an external property manager or external accountant.

## Ownership Assignment

An Ownership Assignment is a temporal relation stating which Legal Entity owns a property, property complex, building, or unit/space for a period. V0 tracks simple validity intervals and audit metadata, not full bitemporal ownership history.

## Management Assignment

A Management Assignment is a temporal relation stating which Party or External Operator manages a property, property complex, building, or unit/space for a period. It is not itself an access grant; access is granted through SpiceDB.

## BetterAuth

BetterAuth is the proposed authentication/session layer. It owns login/session mechanics and maps authenticated users into OntOS principals. It should not be treated as the complete fine-grained authorization system.

## SpiceDB

SpiceDB is the authorization graph. It models relationships and answers permission questions. It is not the business ontology graph.

## OntOS Policy Layer

The OntOS Policy Layer handles business conditions that are not pure relationship-based authorization: module state, locked accounting period, invoice already exported, amount thresholds, approval requirements, document sensitivity, and risk conditions.

## Neo4j Projection

Neo4j Projection is an optional graph projection of registered entities and typed relationships for graph traversal, impact analysis, visual exploration, and future semantic/AI context. It is not the canonical ERP store in V0 and is not required for canonical entity and relation storage.

## Forge

Forge is an internal developer tool for generating MicroVertical skeletons and keeping agent-generated work inside consistent boundaries. It is not the user-facing vibemodule.

## Vibemodule

Vibemodule is a future user-facing capability where new modules can be generated or configured from higher-level descriptions. It requires the MicroVertical manifest, entity registry, relation registry, actions, permissions, migrations, and tests to be mature first. It is not V0 scope.

---


<!-- Source file: 03_ARCHITECTURE_OVERVIEW.md -->


# Architecture overview

OntOS V0 should be understood as a jointly deployable, modular application with strong vertical slices. Each business MicroVertical includes UI and backend behavior together, while Core provides common runtime capabilities. This architecture is deliberately different from a split frontend/BFF/backend model where vertical cohesion is lost across layers.

## Architectural position

The system is a modular monolith, not a microservice platform. It should have strong internal boundaries, but those boundaries are enforced by module manifests, package structure, dependency rules, runtime registries, tests, and ADRs rather than by network calls between services.

The system is not pure event-driven architecture. State changes are initiated through registered Actions and implemented by Command Handlers. Events and outbox messages are emitted as consequences of successful commands and are used to maintain projections, exports, reports, and integrations.

The system is not a generic entity-store platform. Hard business objects such as invoices, leases, reservations, documents, and tickets live in explicit Postgres domain tables. A central entity registry gives those objects stable identity and cross-module addressability.

The system is not an AI product in V0. It should be designed so AI can later consume entities, actions, relations, documents, audit, and timelines, but no committed V0 feature should depend on user-facing AI.

## Runtime shape

The main OntOS Application Runtime contains the application shell, all active MicroVertical UI and server logic, and Core runtime capabilities. The Worker Runtime is separate and processes asynchronous work. Postgres stores canonical state. Neo4j stores a graph projection. SpiceDB stores authorization relationships. Object storage stores file blobs. External accounting systems, reservation web, banks, e-shop, and Pulsar integrations sit outside OntOS.

This separation is important. MicroVertical cohesion is preserved inside the application runtime. Operational simplicity is preserved by avoiding distributed MicroVertical services. Asynchronous work is isolated in workers because projections, exports, imports, notifications, and long-running tasks should not block user-facing command execution.

## MicroVerticals and Core

A MicroVertical is a product/business capability slice. It can own both user experience and business behavior. For example, `property.short_term_rental` can own reservation screens, availability state, reservation actions, reservation command handlers, reservation domain tables, relation types to units/guests/invoices/documents, report descriptors, and tests.

Core owns capabilities that all MicroVerticals require and that should not be reimplemented in business modules: identity mapping, authorization, policy evaluation, module registry, entity registry, relation registry, audit, events, outbox, document metadata, projection infrastructure, and common reporting/search foundations.

This gives us a clear rule: MicroVerticals own domain behavior; Core owns cross-cutting runtime guarantees.

## Data and consistency

Postgres is the canonical operational store. The core business transaction must write domain data, entity registry updates, relation updates, audit events, domain events, and outbox messages in the same transaction where appropriate. Neo4j and search indexes are updated asynchronously via outbox workers.

This means the system tolerates projection lag. A reservation created in Postgres is real even if Neo4j has not yet projected it. A graph view may be temporarily stale; billing and audit must not be.

## Permissions

Authentication and authorization are separate. BetterAuth handles authentication and sessions. An OntOS principal registry maps authenticated subjects into principals. SpiceDB answers relationship-based permission checks. The OntOS Policy Layer evaluates business conditions that are not purely relational.

Search and graph views must be permission-aware. The system should avoid per-result SpiceDB checks for large result sets unless scoped and cached. V0 should combine coarse permission projections with explicit checks for sensitive entities.

## Delivery model

The PoC should validate the stack and the boundaries, not implement the whole ERP. The production V0 should deliver concrete ERP modules and dogfooding while proving the Core abstractions under real usage. Later phases can add e-shop connector, manufacturing, Pulsar integration, deeper workflows, and eventually AI/vibemodule capabilities.

---


<!-- Source file: 04_C4_MODEL.md -->


# C4 model

This document uses C4 as a thinking structure, not as a rigid drawing format. The key correction is that the main runtime is not split conceptually into “web app” and “BFF” containers. OntOS MicroVerticals intentionally include UI and backend behavior together inside one jointly deployable application runtime.

Mermaid diagram sources are in `diagrams/`. The prose below is authoritative; diagrams are support artifacts.

## Level 1 — System Context

OntOS is an ERP and operational ontology system used by internal operator users, customer users, accountants, administrators, and later external operational roles. V0 focuses on ERP delivery for multi-company property/rental operations and accounting handoff. The same foundations support internal dogfooding and later e-commerce/manufacturing extensions.

The external systems around OntOS are accounting software, bank statement sources, the customer’s reservation website, object storage, e-shop systems, and future specialist systems such as Pulsar Solutions for machine/predictive maintenance signals.

The system boundary is important. OntOS owns operational context, workflows, documents, relationships, audit, billing drafts/issued invoices, and ERP reporting. It does not replace statutory accounting software, e-commerce storefronts, or specialist machine-prediction platforms.

## Level 2 — Containers

### OntOS Application Runtime

This is the main jointly deployable application. It hosts the application shell, all active MicroVertical UI, all MicroVertical actions and command handlers, and Core runtime capabilities. In implementation it may expose HTTP routes, pages, server functions, API endpoints, or framework-specific handlers, but those are implementation surfaces inside the same application container.

This container is where the MicroVertical concept lives. Each MicroVertical contributes UI, actions, backend behavior, domain model declarations, migrations, tests, and descriptors through its manifest.

### OntOS Worker Runtime

The worker runtime processes asynchronous work: outbox dispatch, Neo4j projection, search projection, reporting refreshes, import/export processing, scheduled reminders, and later integration jobs. It should share code/contracts with the application runtime but it is operationally separate so that long-running or retryable work does not block user-facing actions.

### Postgres

Postgres stores canonical operational truth: domain tables, entity registry, relation edges, module installations, audit events, domain events, outbox messages, document metadata, invoices, contracts, reservations, tickets, and accounting/export state.

### Neo4j

Neo4j stores a replayable graph projection of entities and typed relationships. It supports graph traversal, impact analysis, visual exploration, and future AI context. It is not the source of truth for operational ERP decisions in V0.

### SpiceDB

SpiceDB stores authorization relationships and answers permission questions. It is not the business ontology graph. Its model should remain focused on access: tenants, legal entities, roles, modules, resources, explicit grants, and relationship-derived access.

### Object Storage

Object storage stores file blobs. OntOS keeps document metadata, ownership, permissions, relations, timeline, and audit in Postgres.

### External Systems

External systems include accounting software, banks/statement files, reservation web, e-shop/Medusa/Helios bridge, and future Pulsar integration. Integrations should normally be mediated by outbox/import/export workers rather than inline calls in user-facing command handlers.

## Level 3 — OntOS Application Runtime components

### Application Shell

The shell provides navigation, layout, tenant/legal-entity context selection, MicroVertical mounting points, shared design-system primitives, and cross-module affordances such as search, entity detail, timeline, and document attachment entry points.

### MicroVertical Runtime

The runtime discovers known MicroVertical manifests, validates dependencies, checks activation state per tenant/legal entity, and exposes contributions to UI, actions, permissions, search, reports, and migrations. In V0, available MicroVertical code is part of the deployable application. Activation of an installed MicroVertical should be runtime-configurable; adding new code still requires deployment.

### Core Runtime Services

Core runtime services include authentication integration, principal context, authorization adapter, business policy layer, module registry, action registry, entity registry, relation registry, audit/event/outbox recording, document metadata services, search interfaces, and projection descriptors.

### MicroVertical Packages

Each MicroVertical package contains the full vertical slice for one business capability: UI, state, routes, actions, command handlers, domain tables, entity/relation declarations, permissions, migrations, report descriptors, search descriptors, fixtures, and tests.

### Action Execution Pipeline

The action execution pipeline receives action invocations from UI, API, imports, or integrations. It resolves the principal and context, checks module state, checks authorization, evaluates business policy, invokes the command handler, and records the necessary audit/domain/outbox records.

## Level 3 — Worker Runtime components

### Outbox Dispatcher

Reads pending outbox messages, claims work idempotently, dispatches to registered handlers, tracks attempts, handles retries, and moves failed messages into a dead-letter state.

### Projection Workers

Maintain Neo4j graph projection, search documents, entity cards, timelines, and reporting aggregates. They are replayable and should tolerate being behind canonical state.

### Import/Export Workers

Handle accounting exports, bank statement imports, future e-shop imports, and other long-running jobs. They should write controlled state transitions back through appropriate actions or explicit worker-owned state machines.

## Level 4 — Code view

A code-level view should be created only after the PoC establishes the actual UltraModern.js project structure. Prematurely defining final folders/packages risks constraining the PoC. The important code-level constraints for now are: MicroVerticals must remain cohesive vertical slices, Core must not import business module internals, and business modules must not mutate each other’s domain tables directly.

---


<!-- Source file: 05_MICROVERTICALS.md -->


# MicroVerticals

This document defines MicroVerticals as they are intended for OntOS. It supersedes any wording that implied a MicroVertical is only a frontend module or that the architecture is naturally split into web and BFF containers.

## Definition

An OntOS MicroVertical is a unified vertical business slice inside one jointly deployable application. It owns both user-facing and server-side behavior for a bounded business capability. It is designed to be understood, generated, tested, activated, and evolved as one unit.

A MicroVertical should normally contain:

| Area | Owned by MicroVertical |
|---|---|
| UI | pages, routes, panels, forms, tables, entity detail sections, dashboard sections |
| State | local state, server-state hooks, view state, filters, query descriptors |
| Actions | declared business actions callable from UI/API/import/integration |
| Command handlers | backend implementation of actions |
| Domain data | domain tables, constraints, migrations, seed data |
| Ontology | entity types, relation types, entity display rules, timeline contributions |
| Authorization | module permissions, resource mappings, action permission requirements |
| Policy | module-specific business rules, state transitions, validation rules |
| Events/outbox | domain events, outbox descriptors, projection handlers |
| Reports/search | search descriptors, report descriptors, metrics definitions |
| Tests | unit, integration, action pipeline, permission, migration, fixture tests |

## What MicroVerticals are not

They are not separate microservices in V0. They are not only UI modules. They are not only backend bounded contexts. They are not arbitrary plugins loaded from untrusted code at runtime. They are not a way to bypass Core.

## Why this model matters

Traditional layered architecture often splits a feature across frontend, backend, database, permissions, jobs, and reporting folders. That makes it easy for a feature to become cross-layer scattered. OntOS needs the opposite: each business capability should have a cohesive home so that humans and coding agents can reason about the whole feature.

A MicroVertical therefore packages the things that change together. The short-term rental slice owns reservation UI and reservation command handling together. The long-term rental slice owns lease contract UI and lease command handling together. The billing slice owns invoice actions and invoice UI together.

## Relationship to Core

Core provides shared capabilities; MicroVerticals consume them. Core should not know business-specific details except through module manifests and declared extension points. MicroVerticals must not reimplement Core concerns.

Examples of Core concerns: authentication integration, authorization adapter, principal context, module runtime, entity registry, relation registry, audit, events, outbox, document metadata, projection dispatch, common search interfaces.

Examples of MicroVertical concerns: what a reservation means, how a lease contract is created, what an invoice draft contains, how an internal delivery ticket links to a project, which reports a property module exposes.

## Runtime activation

In V0, MicroVertical code is part of the application deployment. A module can be activated, suspended, read-only, quarantined, deprecated, or archived per tenant/legal entity without restarting the server. That means runtime activation controls whether UI contributions appear, whether actions are invokable, whether entity types are enabled, and how historical data is displayed.

Adding a brand-new MicroVertical with new code requires deployment in V0. Later versions may support generated/schema-defined modules or sandboxed modules, but that is explicitly not a V0 requirement.

## Activation states

| State | Meaning |
|---|---|
| Active | Module is available for normal read and write usage. |
| Read-only | Data remains visible but write actions are disabled. |
| Suspended | Module is not available in the customer’s current package or payment state; historical data remains preserved. |
| Quarantined | Module is temporarily disabled because of a defect, migration issue, or data safety concern. |
| Deprecated | Module is being replaced but still exists for compatibility. |
| Archived | Module is no longer operational but its historical data remains available for audit/reporting as permitted. |

The key rule is that module deactivation must not destroy company memory. Historical entities, documents, relation edges, audit, and invoices remain addressable subject to permissions.

## Manifest discipline

Every MicroVertical must declare its contract through a manifest. The manifest is not optional documentation; it is the runtime and tooling boundary.

The manifest should include module identity, version, dependencies, owned entity types, relation types, actions, permissions, state machines, UI contributions, route contributions, migrations, search descriptors, report descriptors, outbox handlers, projection handlers, feature flags, and test fixture metadata.

In V0 this can start lightweight. The important part is that the concept exists from the beginning and that new modules cannot grow as unregistered folders of ad hoc code.

## Dependency rules

MicroVerticals may depend on Core and on explicit public contracts of other MicroVerticals. They should not import another module’s internal tables, command handlers, UI internals, or private utilities. Cross-module writes should go through actions or explicit Core-mediated mechanisms. Cross-module reads should use declared read models, entity references, or public query surfaces.

This matters because the long-term product depends on being able to add, replace, suspend, or generate modules without making the entire codebase a single implicit dependency graph.

## MicroVertical Forge

Forge is an internal development tool that should help generate MicroVertical skeletons. It is not the vibemodule product. Its near-term value is to make coding-agent output consistent: manifests, entity declarations, relation declarations, permissions, actions, command handler stubs, migrations, UI stubs, and tests.

Forge should be used to create uniformity, not magic. It should make it harder for a developer or agent to create a module that bypasses Core.

---


<!-- Source file: 06_CORE_KERNEL.md -->


# Core Kernel

The Core Kernel provides the system capabilities that make MicroVerticals safe, consistent, and extensible. It is not a business module and should not contain property-specific, billing-specific, or internal-operator-specific business logic except through generic infrastructure.

## Core responsibilities

Core owns the runtime concepts that every module depends on: identity context, authorization integration, policy evaluation hooks, module registry, module activation, action registry, entity registry, relation registry, audit events, domain events, outbox, document metadata, search interfaces, projection interfaces, and common operational observability.

Core is the reason MicroVerticals can be cohesive without becoming isolated. It gives them shared semantics for identity, actions, entities, links, permissions, audit, and projections.

## What belongs in Core

| Capability | Belongs in Core? | Reason |
|---|---:|---|
| Principal model | Yes | All actors need common identity representation. |
| Tenant/legal-entity context | Yes | Isolation and reporting cut across modules. |
| BetterAuth integration | Yes | Authentication is system-level. |
| SpiceDB adapter | Yes | Authorization decisions must be consistent. |
| Policy hook framework | Yes | Business policies require common enforcement points. |
| Module registry | Yes | Activation and discovery are runtime-level. |
| Action registry | Yes | All writes must use registered actions. |
| Entity registry | Yes | Cross-module identity is system-level. |
| Relation registry | Yes | Cross-module relation semantics are system-level. |
| Audit and domain event recording | Yes | Evidence and event history must be consistent. |
| Outbox | Yes | Side-effect dispatch must be consistent. |
| Document metadata foundation | Yes | Documents must link to any entity. |
| Search interface | Yes | Search spans modules and permissions. |
| Graph projection interface | Yes | Graph projection may span modules even if Neo4j is introduced later. |

## What does not belong in Core

Core should not know how to calculate rent, how to create a reservation, how to map an internal delivery ticket to an invoice draft, how to decide short-term cancellation policy, or how to shape an accounting export for a specific accounting system. Those are MicroVertical or integration responsibilities.

A common failure mode is to put business logic into Core because two modules need something similar. The safer approach is to create explicit shared abstractions only after the second real use case proves they are the same concept. Premature generic Core logic will become harder to change than module code.

## Core as system modules

Core capabilities may be described with manifest-like system modules for consistency, but they are not ordinary business MicroVerticals. For example, `core.ontology` can declare internal entity types such as module installation, relation type, and entity type. `core.audit` can declare audit event structures. `core.documents` can declare document entity type and document relation types.

The key difference is activation. Business MicroVerticals can be active/read-only/suspended/quarantined per tenant. Kernel capabilities cannot simply be suspended without compromising the system. They can have configuration and feature flags, but not ordinary customer-level module off switches.

## Core extension points

Core should expose narrow extension points to MicroVerticals. The important extension points are module manifest registration, action registration, entity type registration, relation type registration, permission mapping, policy hooks, UI contribution points, search descriptors, report descriptors, migration registration, and outbox/projection handlers.

These extension points need to be explicit because they are the future foundation for Forge and later vibemodule capabilities. If modules can mutate runtime behavior through ad hoc imports or global side effects, generation and review become impossible.

## Core should be boring

The Core should not be a showcase for every future ambition. It should be small, strict, and testable. It should enforce invariants: all writes through actions, all actions authorized, all full entities registered, all cross-module links typed, all important changes audited, all asynchronous side effects through outbox, and all module activation states respected.

---


<!-- Source file: 07_RUNTIME_CONSISTENCY_MODEL.md -->


# Runtime and consistency model

OntOS should use an action-driven core with evented side effects. This avoids the main failure mode of naive event-driven ERP architecture: business state changing unpredictably through subscriber chains.

## Write flow

A user, API consumer, import, integration, or later agent invokes a registered Action. The runtime resolves the authenticated principal, tenant context, legal-entity context, module state, authorization, and policy checks before running the Command Handler.

The Command Handler writes canonical state to Postgres in a transaction. When the action changes business state, the same transaction should record the relevant audit event, domain event, and outbox message. After commit, workers process outbox messages and update derived read models or external outputs.

## Why actions before events

A business action is intentional and authorized. A domain event is a record that something happened. If events become the primary mechanism for state changes, the architecture becomes difficult to reason about: subscriber order matters, side effects become hidden, and performance degrades through synchronous fan-out.

For V0, business correctness should live in actions and command handlers. Events are used for history and side effects.

## Domain events

Domain events should be named as past-tense business facts. Examples: lease contract created, reservation cancelled, invoice issued, payment matched, document attached, entity linked, module suspended. They should have small, versioned payloads and reference entities rather than embedding full object snapshots by default.

Domain events are useful for timeline, audit-adjacent explanations, projection triggers, reporting refreshes, and future analytics. They are not a substitute for domain tables.

## Audit events

Audit events capture evidence: actor, principal kind, tenant, legal entity, action, target resource, permission decision, policy decision, before/after summary where needed, request metadata, and timestamp. Audit must be reliable and queryable because both the business and delivery process require traceability.

Audit events are not workflow triggers. They are evidence records.

## Outbox messages

Outbox messages are technical delivery records. They are written transactionally with canonical data so that side effects are not lost when a process crashes between database write and external notification.

Outbox workers handle Neo4j projection, search projection, reporting refresh, accounting export preparation, future notifications, and future integration events. Handlers must be idempotent, retryable, observable, and capable of dead-lettering.

## Synchronous vs asynchronous work

Synchronous action execution should include authentication, authorization, policy checks, validation, canonical Postgres writes, audit/domain/outbox recording, and small local derived values. It should not include external API calls, Neo4j writes, search indexing, report recomputation, email/SMS delivery, or heavy imports.

Asynchronous workers should handle all side effects that can be retried or rebuilt. The user-facing action should return once canonical state is committed.

## Consistency levels

Operational ERP state is strongly consistent inside Postgres transactions. Graph, search, reporting, and integration projections are eventually consistent. The UI must be honest about this when necessary. For example, a graph view can show projection freshness or lag if relevant.

The architecture must tolerate projection failures. A failed Neo4j projection should not invalidate a created invoice. A failed accounting export worker should leave an export batch in a failed state for retry, not roll back the original invoice unless that was explicitly modeled as a reversible business action.

## Performance guardrails

The first implementation should include guardrails rather than assuming performance will be fine. Useful early measurements include API p95/p99 latency, DB query count per request, slow queries, event loop delay, SpiceDB check latency, outbox lag, worker duration, Neo4j projection lag, and search latency.

The runtime should avoid unbounded relation expansion, unbounded synchronous subscribers, per-result authorization calls in large search result sets, large event payloads, and heavy work inside request handlers.

---


<!-- Source file: 08_CANONICAL_ENTITY_MODEL.md -->


# Canonical entity model

OntOS needs both strong domain modeling and universal cross-module linking. The chosen model is explicit Postgres domain tables plus a central entity registry and typed relation edges.

## Why not generic JSON/EAV

A generic `entities` table with arbitrary JSON payloads would make early prototyping look flexible, but it would damage ERP correctness. Billing, rental contracts, reservations, payments, accounting exports, reporting, constraints, indexes, migrations, and auditing need explicit structures. A generated/custom module layer may later use metadata-backed storage, but V0 core ERP data should not be built on generic JSON as the primary model.

## Why entity registry

Direct foreign keys between every possible module pair would tightly couple modules. For example, billing may need to link invoices to reservations, lease contracts, service tickets, documents, contacts, and internal delivery tickets. Hard foreign keys for every future relationship would create an expanding web of dependencies.

The entity registry gives each full business entity a stable identity. Modules can link to an `entity_ref` without importing the target module’s internal tables. The registry also supports global search, timeline, graph projection, and future AI context.

## Full entity vs child row

A full entity has independent business identity over time. It is addressable, searchable, linkable, auditable, and can appear in timelines, reports, and permissions. Examples include legal entity, property, building, unit, contact, lease contract, reservation, invoice, payment, document, service ticket, accounting export batch, client, project, and ticket.

A child row or value object exists inside a parent and should not be independently addressable by default. Examples include invoice lines, tax breakdown rows, price breakdown rows, payment schedule items, contact methods, checklist items, and export lines.

A child row can later be promoted into an addressable child entity if it develops its own lifecycle, permissions, document links, workflow, reporting, or external identity.

## Entity registry binding

A full entity should have a row in its domain table and a corresponding row in `entity_registry`. The domain table holds operational truth. The registry holds global identity and addressing metadata.

The registry should capture tenant id, entity type key, stable entity id, owning module, display name, lifecycle/status, legal-entity scope, storage binding, sensitivity/access class, timestamps, and current schema version.

The physical storage binding is an implementation detail. External references and cross-module links should use `entity_ref`, not raw table/id pairs as the public contract.

## Entity types

An entity type defines a kind of business entity. Examples include `property.unit`, `property.lease_contract`, `property.reservation`, `billing.invoice`, `documents.document`, `facility.service_ticket`, `internal.project`, and `internal.ticket`.

Entity types are owned by modules, versioned, and declared through manifests. The type key should remain semantically stable. Breaking changes should produce explicit migrations or new major versions rather than silently changing the meaning of existing entities.

## Relation types

A relation type defines the meaning and constraints of a relationship. A relation edge without a relation type is not acceptable because it does not explain why two entities are linked.

A relation type should define owner module, source entity types, target entity types, cardinality, inverse relation, temporal behavior, timeline visibility, graph visibility, search weight, permission implications, and whether it can be created by user, system, import, integration, or future agent.

Examples include lease contract for unit, reservation for unit, invoice generated from reservation, invoice generated from lease, document attached to entity, payment settles invoice, service ticket affects unit, cost allocated to property, and project has ticket.

## Entity edges

An entity edge is a concrete relationship between two entity refs under a relation type. Edges should be tenant-scoped, typed, auditable, and temporal-ready. V0 can start with valid-from/valid-to, recorded-at, recorded-by, source, status, and metadata fields without implementing full bitemporal history everywhere.

Edges are canonical in Postgres. Neo4j receives a projection.

## Neo4j projection

Neo4j should project entity registry rows as nodes and entity edges as relationships. It can denormalize display names, statuses, module ids, entity types, tenant ids, and selected domain properties useful for graph exploration. It should not store the full operational record for invoices, contracts, or reservations as the only truth.

If Neo4j is unavailable or stale, canonical ERP operations should continue. Graph views may degrade or show projection lag.

## V0 entity catalog

The first entity catalog should include Core entities, property entities, rental entities, billing entities, accounting workflow entities, document entities, facility entities, and internal dogfood entities.

Core: tenant, legal entity, party, counterparty, external operator, org unit, principal, user, agent placeholder, module installation.

Property/rental: property, property complex, building, unit/space, contact, lease contract, reservation, guest/contact, ownership assignment, management assignment, service ticket. Capacity allocation contract is a future commercial-rights pattern unless a concrete V0 customer workflow requires it.

Billing/accounting: invoice draft, invoice, payment, supplier invoice or cost record, accounting export batch.

Documents: document, with file versions as child rows initially.

Internal dogfood: client, project, ticket, invoice draft, document.

---


<!-- Source file: 09_AUTHN_AUTHZ_MODEL.md -->


# Authentication and authorization model

OntOS should separate authentication, principal modeling, relationship authorization, and business policy.

## Authentication

BetterAuth is the proposed authentication/session layer. Its responsibility is login, sessions, authentication methods, and developer experience around user authentication. OntOS should not make BetterAuth the only source of business authorization semantics.

An authenticated BetterAuth user is mapped to an OntOS principal. The OntOS principal is the identity used in audit, authorization, and action execution.

## Principal model

A principal is an actor in the system. The principal kind can be internal user, external operator user, guest user, agent, service account, integration, or system. V0 may only use human users and basic integration/service principals in production, but the model should include agent principals as a foundation.

Agent principals do not imply autonomous agent product features in V0. They simply keep the actor model future-proof and make it possible to audit system/non-human actions consistently.

## Tenant and legal-entity context

Every action and read should execute inside a tenant context. Many actions also execute inside a legal-entity context. Tenant is the top-level isolation boundary. Legal entity is the managed accounting or operating company scope inside the tenant. External managers, guests, accountants, suppliers, and other counterparties are Parties or Principals with scoped access; they are not automatically tenant legal entities.

Tenant leakage is a critical defect. It should be tested explicitly.

## Relationship-based authorization

SpiceDB is the fine-grained authorization system. In V0 it should stay coarse and security-critical: tenant membership, legal-entity roles, module access, admin/support powers, accounting/export powers, and explicit grants to sensitive resources.

SpiceDB should not mirror every business ontology edge. Business relationships and authorization relationships overlap but are not the same thing.

## OntOS Policy Layer

The Policy Layer handles conditions that are not pure relationship authorization. Examples: module suspended, module read-only, accounting period locked, invoice already exported, document sensitivity, amount threshold, approval required, action disabled by feature flag, or tenant over package limit.

The normal write path is authentication, principal resolution, context resolution, module state check, SpiceDB permission check, policy check, command execution.

## Read and search authorization

Reads need the same seriousness as writes. Entity detail reads can run explicit checks. Search is more difficult because result sets can be large. V0 should use tenant/legal-entity/module/access-class scoping for search documents and explicit authorization checks for sensitive results.

A naive search implementation that calls SpiceDB once per result can become a latency and cost problem. The architecture should include permission projections or coarse prefilters for common searches.

## View as principal

For debugging and support, the system may later support “view as principal” for admins. This should not be treated as actual login as another user/agent. It should be read-only or explicitly controlled, and it must audit original principal, viewed principal, reason, and timestamp.

## Consistency with SpiceDB

Not every business write should synchronously write to SpiceDB. V0 should keep SpiceDB relationships relatively coarse and should not mirror the whole business ontology. Business entity access can often be evaluated through tenant/legal-entity/module scope plus policy, rather than one SpiceDB tuple per ordinary entity.

Role and access changes are security-critical and should fail closed if SpiceDB cannot be updated. Derived or helper relationships can be projected asynchronously if introduced later.

---


<!-- Source file: 10_DATA_STORAGE_AND_PROJECTIONS.md -->


# Data storage and projections

OntOS deliberately uses multiple data stores, each with a clear responsibility. This is not polyglot persistence for prestige; it exists because operational ERP data, graph exploration, authorization, and file blobs have different shapes.

## Postgres

Postgres is the canonical operational store. It should contain domain tables, entity registry, relation edges, module installations, audit events, domain events, outbox, document metadata, invoices, reservations, lease contracts, payments, cost records, accounting export state, internal dogfood entities, and current state needed for transactional operations.

Postgres is where constraints, indexes, migrations, accounting/reporting queries, and auditability must be reliable.

## Neo4j

Neo4j is an optional graph projection of the company ontology. It may become useful for multi-hop relationships, impact analysis, visual exploration, and future AI context. It should be rebuilt from Postgres if introduced. It should not be required to issue an invoice, create a lease, create a reservation, or enforce core permissions in V0.

The projection should include entity nodes and typed relation edges, plus selected denormalized display/status/type/module/tenant fields. Avoid dumping all child rows or large sensitive payloads into Neo4j by default.

## SpiceDB

SpiceDB is the authorization store. It stores relationship tuples and permission schema. It should be fed by deliberate access-management actions, not by blindly mirroring every business relation. OntOS treats SpiceDB as foundation-level infrastructure because hand-rolled authorization creates too many failure points.

## Object storage

Object storage holds binary file content. Document metadata, links, ownership, permissions, expiration, versions, and audit live in Postgres. A file blob without a document metadata entity is not a business document in OntOS.

## Search index

The first search implementation may be Postgres-based. The architecture should still treat search documents as projections because later search may move to a dedicated engine. Search documents should include tenant, legal entity, module, entity type, display fields, searchable text, facets, updated timestamp, and permission/access-class fields.

## Projection lag

Projection lag is acceptable for Neo4j, search, and reporting if surfaced appropriately. It is not acceptable for canonical billing or audit. Workers should record projection status and support replay/rebuild.

## Rebuildability

All projections must be rebuildable from canonical state. This includes Neo4j graph, search documents, entity cards, timelines where derived, and reporting aggregates. The system should not require manual database surgery to recover from projection corruption.

---


<!-- Source file: 11_V0_SCOPE_AND_MODULES.md -->


# V0 scope and modules

V0 must deliver a useful ERP aligned with the committed customer scope while establishing the foundations needed for future productization. It should not deliver the entire long-term OntOS vision.

## V0 Core capabilities

V0 Core should include tenant/legal-entity model, principal model, BetterAuth authentication integration, SpiceDB authorization adapter, policy layer, module registry, module activation, action registry, entity registry, relation registry, audit events, domain events, outbox, worker runtime, document metadata, basic search, basic reporting foundations, and module manifests.

These capabilities are not optional platform indulgence. They are required to safely deliver multi-company ERP modules with permissions, audit, documents, exports, and cross-module links.

## V0 business MicroVerticals

### `property.registry`

Current working assumption: this is the first customer-domain MicroVertical to validate after the foundation skeleton. It likely covers legal-entity property structures: properties or property complexes, buildings, units/spaces, ownership/management relationships, unit/space state, basic technical metadata, equipment/labels, and links to documents/service tickets/reporting. It appears to be the dependency root for long-term rental, short-term rental, facility, billing, documents, search, and reporting.

Open boundary to validate: lease contracts, reservations, pricing, invoicing, payments, cleaning tasks, facility workflows, accounting costs, and reporting aggregates probably belong to later MicroVerticals and link back to registry entities through typed relations.

### `internal.delivery`

This early dogfood MicroVertical should cover clients, projects, tickets, documents, and invoice drafts after the customer-domain rails are proven by `property.registry`. It is valuable because the internal operator can discover issues in entity linking, permissions, document attachment, action flow, and billing drafts before those patterns are repeated broadly.

### `property.long_term_rental`

This MicroVertical covers lease contracts, tenants/contacts, deposits, basic payment schedules, terms, attachments, reminders, and links to invoices/documents/units.

### `property.short_term_rental`

This MicroVertical covers units/spaces, reservations, guests/contacts, reservation state, check-in/check-out basics, cleaning tasks, cancellation/change basics, and invoice draft links. It should support guests as external actors. First-class capacity allocation contracts are a future discovery topic unless a concrete customer workflow requires them.

### `billing.core`

This MicroVertical covers invoice drafts, issued invoices basic, numbering series, legal-entity billing identity, receivables status, payment state basics, and export-ready invoice evidence.

### `accounting.office` and `accounting.export`

These MicroVerticals cover accounting workflow and handoff, not statutory accounting. V0 should include client/company workspace, document inbox basics, supplier/cost record basics, checklist/status workflow, expense assignment to legal entity/property/unit/contract, basic approvals, and export/import structure for the selected accounting system or Excel-based handoff.

### `documents.center`

This MicroVertical or Core-adjacent system module covers document metadata, upload, categorization, entity links, permissions, expiration, versions as child rows initially, and audit.

### `facility.basic`

This MicroVertical covers service tickets, issue states, priority, responsible person/supplier, photo/document links, and unit/building/property links. It should be minimal in V0.

### `reporting.basic`

Basic reporting should cover active contracts, reservations, occupancy basics, receivables, costs, export status, and holding/legal-entity views. Advanced BI/report builder is later.

## V0 exclusions

V0 excludes user-facing AI assistant, document AI automation, autonomous agents, process autodiscovery, user-facing vibemodule, full manufacturing ERP, machine/PLC integration, predictive maintenance, full channel manager/Airbnb/Booking integration, external portals, and full accounting engine.

The architecture should be ready to integrate these later without implementing them now.

## Accounting boundary

OntOS should not implement statutory accounting. It should provide operational evidence, billing records, cost records, document links, approval/checklist workflow, and export/integration to accounting software. This boundary is important because the customer context explicitly prefers integration with mature accounting software rather than building accounting correctness ourselves.

## Manufacturing and Pulsar boundary

Manufacturing in 2027 should be handled as OntOS manufacturing operations plus integration with a specialist partner for machine prediction and predictive maintenance. OntOS should own production orders, products, BOM, material reservation, service tickets, ISO evidence, documents, and audit. Pulsar-like specialist systems can own machine analytics and prediction outputs, which OntOS receives as events or integration payloads.

---


<!-- Source file: 12_ROADMAP.md -->


# Roadmap

This roadmap is intentionally agile. It sets monthly delivery intent and architectural proof points; it is not a waterfall specification.

## End of May 2026 — throwaway PoC

The PoC should validate the stack and the architectural seams. It is expected to be disposable. It should prove UltraModern.js MicroVertical structure, design-system integration, BetterAuth session mapping to OntOS principal, SpiceDB permission checks, Postgres entity registry, relation edges, audit recording, outbox basics, module activation/deactivation, internal dogfood slice, and property/rental stubs. Neo4j can be tested as an optional projection spike, but the PoC should not make V0 depend on it.

The PoC should not implement product AI, full rental workflows, full billing, full accounting integration, or polished UX.

## June 2026 — architecture decision month

June should convert PoC learnings into decisions. Key outputs are a refined glossary, accepted/rejected ADRs, V0 scope lock, MicroVertical manifest shape, Core/MicroVertical boundaries, authz approach, entity model, relation model, outbox model, module activation model, and customer process clarification.

This month should avoid building a large production system before the architecture has been grilled. It should produce enough production skeleton to start safely in July.

## July 2026 — production foundation and property registry start

July should establish the production skeleton, tenant/legal entity model, principal model, BetterAuth integration, SpiceDB checks, module registry, action registry, entity registry, relation registry, audit, timeline basics, and the first `property.registry` slice.

The customer-facing property structure should begin with holding/SRO and property/unit registry skeletons. Internal dogfooding can start once these rails are working.

## August 2026 — property base, documents, search

August should build the property registry, contacts/CRM basics, document center basics, entity linking UX, search basics, module unavailable states, read-only/quarantine behavior, audit hardening, and permission tests. Internal dogfooding should begin to produce real feedback.

## September 2026 — long-term and short-term rental MVPs

September should deliver pilotable long-term rental and short-term reservation slices. Long-term rental should include lease contracts, tenant/contact links, unit links, deposits/basic payment schedules, terms, attachments, and invoice draft links. Short-term rental should include reservations, guests/contacts, reservation state, check-in/check-out basics, cleaning tasks, cancellation/change basics, and invoice draft links.

## October 2026 — billing and accounting workflow

October should deliver billing basics and accounting workflow/export. This includes invoice drafts, issued invoice basics, numbering series, legal-entity billing identity, receivables/payment state basics, client/company accounting workspace, document inbox basics, cost/supplier invoice basics, checklist/status workflow, and accounting export/import baseline.

Any delivery-scope changes should be identified before the late-October change review window.

## November 2026 — stabilization, import, UAT

November should stop adding major scope. Focus should move to real data imports, UAT scenarios, rental fixes, billing fixes, accounting export fixes, permission hardening, audit hardening, search stabilization, basic reports, and handover evidence.

Product AI remains out of scope.

## December 2026 — handover and acceptance evidence

December should deliver production/staging handover, final UAT, documentation, admin guide, user guide, function evidence, screenshots, handover materials, acceptance evidence, and support/hypercare plan.

## 2027 high-level business roadmap

Q1 2027 should focus on hypercare, deeper accounting integration, internal dogfooding, and e-shop connector discovery or first slice. Q2 should focus on e-shop connector and manufacturing discovery with Pulsar boundary definition. Q3 should focus on manufacturing light and Pulsar/machine event PoC. Q4 should focus on workflow automation, reporting/controlling, Forge v1, and product packaging for additional customers.

---


<!-- Source file: 13_GRILL_QUESTIONS.md -->


# Grill questions

This document is intentionally adversarial. Use it to challenge the architecture before implementation.

## MicroVertical semantics

1. Is the definition of MicroVertical precise enough to implement consistently?
2. Which files/artifacts must every MicroVertical have before it is considered valid?
3. How do we prevent a MicroVertical from importing another MicroVertical’s internals?
4. How does a MicroVertical contribute UI without becoming a runtime plugin system too early?
5. How does a MicroVertical contribute backend actions while preserving centralized authz, audit, and outbox rules?
6. Is “one deployable app with unified vertical slices” compatible with the UltraModern.js implementation model?
7. What does module activation mean if the code is already deployed?
8. What exactly happens when a module is suspended or quarantined?

## Core boundaries

1. Which capabilities are truly Core and cannot be moved into a MicroVertical?
2. Is document center Core, a MicroVertical, or a Core-adjacent system module?
3. Is billing base Core or a business MicroVertical?
4. Where should shared CRM/contact primitives live?
5. How do we keep Core from becoming a dumping ground?

## Consistency and events

1. Are there any state changes that currently bypass registered Actions?
2. Which side effects must be outbox-driven from day one?
3. Which projections are allowed to lag?
4. Which operations require immediate consistency?
5. What is the minimal outbox implementation that is safe enough for V0?
6. What metrics prove that event/outbox processing is not becoming a bottleneck?

## Entity model

1. What exact criteria make something a full entity?
2. Which V0 objects are full entities vs child rows?
3. Does every full entity require a detail page, or only addressability?
4. How are entity types versioned?
5. How are relation types versioned?
6. What happens when a relation type is deprecated?
7. How do we prevent generic `relates_to` links from destroying semantic value?

## Authorization

1. Is SpiceDB appropriate for V0 or too heavy for the team?
2. What is the minimum SpiceDB schema that proves value without modeling every business relation?
3. Which permissions are handled by SpiceDB vs OntOS Policy Layer?
4. How is search permission filtering implemented without one SpiceDB call per result?
5. What is the fail-closed behavior when SpiceDB is unavailable?
6. How are role changes audited?

## Data stores

1. Is Neo4j necessary in the PoC, or should it be introduced after entity registry and edges stabilize?
2. What will be the first graph query that justifies Neo4j?
3. How do we rebuild Neo4j from Postgres?
4. What data must never be projected into Neo4j?
5. Is Postgres full-text enough for V0 search?

## Delivery realism

1. Does the June–December roadmap fit two FTE developers plus agents?
2. Which V0 feature is most likely to break the schedule?
3. What can be cut while still satisfying committed delivery?
4. What is the minimum useful accounting workflow/export?
5. What is the minimum useful short-term reservation module?
6. What is the minimum useful long-term rental module?
7. How early can internal dogfooding start without distracting from customer scope?

## PoC acceptance

1. What must the May PoC prove before we accept the stack?
2. What PoC result would cause us to drop Neo4j from V0?
3. What PoC result would cause us to drop SpiceDB from V0?
4. What PoC result would show that MicroVertical cohesion is not working?
5. What PoC result would show that coding agents need stricter scaffolding?

---


<!-- Source file: appendix/00_SOURCE_GROUNDING.md -->


# Source grounding

This pack is based on the current conversation, previous OntOS architecture research artifacts, and private source materials summarized at a high level.

## Internal strategy source

The internal strategy material frames OntOS as a strategic internal/hybrid opportunity. It lists options such as internal project, consortium, and hybrid approach. The hybrid direction is particularly relevant: keep the project small/internal until a presentable MVP exists, then consider adding names, investors, and public positioning.

## Draft module source

The private module analysis defines the customer-facing ERP scope: holding/SRO support, property/unit registry, long-term rental, short-term rental, pricing, billing, payments, accounting exports, costs, service/energy settlement, facility, CRM, communication templates, document center, reporting, roles/permissions, administration, integrations/API, and future portals. It also explicitly positions the system as more than “software for rentals”: a holding asset/property management system with accounting, billing, operational, and reporting layers.

## Delivery source

The private delivery materials establish the hard 2026 delivery context: the customer needs a new ERP system, demonstrable digitalization, and enough acceptance evidence to show that the delivered system supports the required business workflows.

## Evidence-research sources

Previous research packs in the conversation explored ERP/platform architectures, canonical entity models, C4 documentation, modular ERP precedents, transactional outbox, SpiceDB/BetterAuth/Neo4j/C4 official documentation, Odoo/Frappe/Dataverse/Salesforce/Palantir patterns, and performance risks around event-driven module systems.

## How this pack should be used

This pack is not the final architecture. It is a structured input for `/grill-with-docs`, PoC planning, and architecture review. Any coding agent should treat the ADRs as proposed decisions and the open questions as active design pressure.

---


<!-- Source file: adr/0001-microverticals-are-unified-vertical-slices.md -->


# ADR-0001: MicroVerticals are unified vertical slices

Status: Proposed

## Context

Earlier architecture wording separated “web app” and “BFF/API” as if frontend and backend were separate containers and MicroVerticals lived across that split. That does not match the intended UltraModern.js MicroVertical concept.

The project needs feature cohesion, fast development with coding agents, and one jointly deployable application for V0. Splitting every feature across separate frontend and backend architectural containers obscures the desired vertical ownership.

## Decision

An OntOS MicroVertical is a unified vertical slice containing both frontend and backend concerns for a bounded business capability. A MicroVertical owns its UI, routes, components, state, actions, command handlers, domain code, migrations, tests, entity declarations, relation declarations, permissions, search/report descriptors, and projection descriptors.

MicroVerticals are deployed together in V0 as part of one OntOS Application Runtime. They are not independently deployed microservices.

## Consequences

The architecture should model one OntOS Application Runtime container rather than separate Web App and BFF containers at the conceptual C4 container level. Framework-specific internal routes or handlers may exist, but they are implementation details inside the unified runtime.

MicroVertical manifests become central. Coding agents should generate MicroVerticals as cohesive slices, not as disconnected frontend/backend fragments.

## Risks

Vertical cohesion can become an excuse for duplicating shared logic. Core must provide system capabilities, and MicroVerticals must consume them rather than reimplement them.

---


<!-- Source file: adr/0002-modular-monolith-for-v0.md -->


# ADR-0002: V0 uses a modular monolith, not microservices

Status: Proposed

## Context

The team is small, the delivery timeline is constrained, and the domain is still being discovered. Distributed services would increase deployment, debugging, schema evolution, observability, and operational complexity before the product has stable boundaries.

## Decision

OntOS V0 will be implemented as a TypeScript modular monolith/modulith using UltraModern.js MicroVerticals. Module boundaries are internal package/runtime boundaries, not network boundaries.

## Consequences

Local development, transactions, refactoring, and deployment remain simpler. Hot paths can be extracted later based on measurement. The architecture must still enforce module boundaries through manifests, dependency rules, tests, and review.

## Risks

A modular monolith can degrade into a big ball of mud if boundaries are not enforced. The MicroVertical manifest and dependency rules are therefore not optional.

---


<!-- Source file: adr/0003-action-driven-core-evented-side-effects.md -->


# ADR-0003: State changes through Actions, side effects through events/outbox

Status: Proposed

## Context

Naive event-driven architecture can produce unpredictable state changes when synchronous subscribers mutate business state. The system must be understandable, auditable, and performant.

## Decision

Business state changes only through registered Actions implemented by Command Handlers. Successful commands record canonical state, audit events, domain events, and outbox messages in Postgres. Events and outbox messages trigger projections and integrations after commit.

## Consequences

Business correctness stays in commands. Events explain what happened. Outbox workers handle side effects such as Neo4j projection, search indexing, reporting refreshes, and accounting export preparation.

## Risks

The team must resist adding “quick” inline side effects in command handlers. Tests and code review should enforce the pattern.

---


<!-- Source file: adr/0004-postgres-canonical-neo4j-projection.md -->


# ADR-0004: Postgres is canonical; Neo4j is an optional projection

Status: Proposed

## Context

The long-term vision depends on graph exploration, but V0 ERP operations require reliable transactional storage, constraints, migrations, billing, accounting exports, and audit.

## Decision

Postgres is the canonical operational source of truth. Neo4j, if included in V0, is a replayable graph projection of entity registry rows and typed relation edges. The entity registry and typed relation edges must stand on their own without Neo4j.

## Consequences

ERP operations do not depend on Neo4j availability or even on Neo4j being present. Graph views may be eventually consistent. Neo4j can be introduced later and rebuilt from Postgres and domain events.

## Risks

If application code starts making operational decisions based only on Neo4j, the model breaks. That must be prohibited for V0. The remaining risk is delaying graph feedback too long and discovering too late that relation semantics are too weak for useful traversal.

---


<!-- Source file: adr/0005-betterauth-spicedb-policy-layer.md -->


# ADR-0005: BetterAuth + SpiceDB + OntOS Policy Layer

Status: Proposed

## Context

The system needs authentication, sessions, multi-tenant/user DX, relationship-based authorization, and business-specific policy checks. Custom authorization logic spread through application code is too easy to get wrong, especially across tenants, legal entities, modules, and sensitive records. One tool should not be forced to solve all of these.

## Decision

BetterAuth handles authentication and session DX. OntOS maps authenticated users into principals. SpiceDB handles coarse, security-critical relationship-based authorization: tenant membership, legal-entity roles, module access, admin/support powers, accounting/export powers, and explicit grants to sensitive resources. OntOS Policy Layer handles business policies such as module state, locked periods, invoice already exported, amount thresholds, and approval requirements.

## Consequences

Authn, authz, and business policy remain separate. SpiceDB should not mirror the entire company ontology graph. Business relations and authorization relations are related but distinct.

## Risks

SpiceDB can still become too heavy if the schema is over-modeled. V0 must keep the schema deliberately small and validate latency, consistency behavior, and search-filtering strategy early.

---


<!-- Source file: adr/0006-explicit-domain-tables-plus-entity-registry.md -->


# ADR-0006: Explicit domain tables plus entity registry

Status: Proposed

## Context

OntOS needs cross-module linking without destroying domain integrity. A single generic JSON/EAV table would be flexible but weak for ERP constraints, billing, exports, and reporting. Direct foreign keys between every module pair would create tight coupling.

## Decision

Use explicit Postgres domain tables for operational data. Register full business entities in a central entity registry. Store cross-module links as typed relation edges using stable entity references.

## Consequences

Modules can keep strong domain models while participating in the company ontology. Neo4j can project the registry and relation edges. Search and timelines can operate across modules.

## Risks

The team must define criteria for full entities vs child rows. If everything becomes an entity, the graph becomes noisy and expensive.

---


<!-- Source file: adr/0007-no-product-ai-in-v0.md -->


# ADR-0007: No product AI in V0

Status: Accepted for current planning

## Context

The team capacity and delivery deadline require focus. Product AI features are attractive but not required for committed delivery and would create significant scope risk.

## Decision

V0 is AI-ready but not AI-first as a product. AI may be used heavily in development. User-facing AI assistant, document AI automation, autonomous agents, process autodiscovery, and vibemodule are out of V0 scope.

## Consequences

Architecture should preserve future AI hooks through entity registry, actions, audit, documents, and relations. Implementation does not depend on AI features.

## Risks

The product vision may tempt scope creep. This ADR should be revisited after V0 foundations are stable.

---


<!-- Source file: adr/0008-module-activation-state-model.md -->


# ADR-0008: Module activation and state model

Status: Proposed

## Context

Tenants and legal entities may have different modules enabled. Modules may need to be suspended, made read-only, quarantined, deprecated, or archived without deleting history.

## Decision

Installed MicroVertical code is deployed with the application. Runtime module installation state controls availability per tenant/legal entity. States include active, read-only, suspended, quarantined, deprecated, and archived.

## Consequences

Activation/deactivation can happen without restart for installed modules. New module code still requires deployment in V0. Historical data remains visible according to permissions even when a module is not active.

## Risks

Every Action, UI contribution, search descriptor, and report must respect module state. Missing checks can expose disabled functionality.

---


<!-- Source file: adr/0009-postgres-outbox-idempotent-workers.md -->


# ADR-0009: Postgres outbox and idempotent workers

Status: Proposed

## Context

The system must write canonical state and trigger projections/integrations without dual-write inconsistency. Inline external side effects would make user-facing actions slow and fragile.

## Decision

Use a Postgres outbox table written in the same transaction as business changes. Worker runtime processes outbox messages idempotently and handles retries, failures, and dead-letter states.

## Consequences

Neo4j, search, reporting, and exports become eventually consistent and replayable. User-facing commands remain focused on canonical writes.

## Risks

Outbox lag must be observable. Handlers must be idempotent. Without metrics, projection failures could go unnoticed.

---


<!-- Source file: adr/0010-separate-business-ontology-and-authz-graph.md -->


# ADR-0010: Separate business ontology graph and authorization graph

Status: Proposed

## Context

OntOS uses both business entity relationships and authorization relationships. Neo4j and SpiceDB both represent graphs, but they solve different problems.

## Decision

Business ontology relationships are canonical in Postgres entity edges and projected to Neo4j. Authorization relationships are stored in SpiceDB. The two graphs may reference the same concepts, but they are not the same graph.

## Consequences

Neo4j answers relationship/exploration questions. SpiceDB answers permission questions. This avoids mixing semantic business links with access-control decisions.

## Risks

Developers may attempt to reuse Neo4j for permissions or SpiceDB for business ontology. Documentation and adapters should make that difficult.

---


<!-- Source file: adr/0011-internal-dogfood-early.md -->


# ADR-0011: Internal dogfooding starts early

Status: Proposed

## Context

The system will be used by a customer, but the internal operator also needs an operational slice: clients, projects, tickets, documents, and invoice drafts. This is a low-friction way to validate foundations, but it must not displace the customer-domain dependency root.

## Decision

Current planning assumption: `property.registry` is the likely first customer-domain slice after the foundation skeleton. The `internal.delivery` MicroVertical should start early after those rails are proven, validating entity linking, document attachment, permissions, audit, invoice drafts, and module activation without distracting from committed customer scope.

## Consequences

The customer-domain backbone is explored first. The team still experiences its own UX and architecture issues early, but dogfooding follows the same rails instead of setting the initial direction.

## Risks

Dogfooding must not distract from committed customer scope. It should remain narrow and foundation-oriented.

---


<!-- Source file: adr/0012-pulsar-for-machine-prediction.md -->


# ADR-0012: Machine prediction is integrated, not built in OntOS V0/V1

Status: Proposed

## Context

Manufacturing and machine prediction are future business opportunities, but the team does not want to build predictive maintenance technology internally. Pulsar Solutions is a likely specialist partner.

## Decision

OntOS should own manufacturing operations, ERP context, service tickets, ISO evidence, documents, audit, and workflows. Pulsar or similar systems should own machine data analytics and predictive maintenance outputs. OntOS integrates their outputs as external events or recommendations.

## Consequences

The manufacturing roadmap becomes lower risk. OntOS remains the operational ontology and workflow layer rather than a machine-learning platform.

## Risks

Integration boundaries must be defined early enough in manufacturing discovery. OntOS must not assume machine event quality or availability without PoC evidence.
