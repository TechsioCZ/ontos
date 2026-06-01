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
