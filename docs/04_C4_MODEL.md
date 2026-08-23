# C4 model

This document uses C4 as a thinking structure, not as a rigid drawing format. UltraModern.js MicroVerticals intentionally include UI and backend behavior together while preserving strict independent deployment seams. OntOS Business Modules normally use that implementation shape; local and network Adapters preserve the same published interface.

Mermaid Markdown diagrams are in `diagrams/`. The prose below is authoritative; diagrams are support artifacts.

## Level 1 — System Context

OntOS is the encompassing modular business product used by internal operators, customer users, accountants, administrators, customers, and external operational roles. ERP and Commerce are Application Compositions of OntOS Foundational and Business Modules. Commerce is first configured for Akros and then N1.

The external systems around OntOS include Symmy, accounting software behind Symmy, bank statement sources, customer reservation websites, object storage, payment and delivery providers, and specialist systems such as Pulsar Solutions.

The system boundary is important. OntOS owns Core, reusable business capabilities, the back office, and the canonical facts assigned to its modules. It does not automatically replace statutory accounting software, Storefront Channel Applications, Symmy, or specialist machine-prediction platforms.

## Level 2 — Containers

### OntOS Shell and MicroVertical delivery units

The Shell composes installed, authorized Business Module contributions. Each MicroVertical delivery unit contains one Business Module's UI, Actions, handlers, schema, and private runtime registration and remains independently deployable. Co-location is a Deployment Topology choice, not a change in logical ownership.

This container is where the MicroVertical implementation concept lives. Each OntOS Business Module contributes UI, actions, backend behavior, domain model declarations, migrations, tests, and public descriptors. Its public activation and cross-module contract is declared through the OntOS Module Manifest.

### OntOS Worker Runtime

The worker runtime processes asynchronous work: outbox dispatch, Neo4j projection, search projection, reporting refreshes, import/export processing, scheduled reminders, and later integration jobs. It should share code/contracts with the application runtime but it is operationally separate so that long-running or retryable work does not block user-facing actions.

### Postgres

Postgres stores canonical operational truth: module-owned domain tables, Core runtime tables, audit events, domain events, outbox messages, media metadata/links, search projection entries, invoices, contracts, reservations, tickets, and accounting/export state.

### Neo4j

Neo4j stores a replayable graph projection of module-owned resources, selected ResourceRefs, and domain-specific relationships. It supports graph traversal, impact analysis, visual exploration, and future AI context. It is not the source of truth for operational ERP decisions in V0.

### SpiceDB

SpiceDB stores authorization relationships and answers permission questions. It is not the business ontology graph. Its model should remain focused on access: tenants, legal entities, roles, modules, resources, explicit grants, and relationship-derived access.

### Object Storage

Object storage stores file blobs. OntOS keeps media metadata, links, permissions-relevant context, timeline, and audit in Postgres.

### External Systems

External systems include Symmy, accounting software, banks/statement files, reservation websites, payment/delivery providers, and future Pulsar integration. OntOS reaches provider systems through the Symmy Connector; provider-specific routes such as Symmy–POHODA Integration stay downstream. Integrations should normally be mediated by outbox/import/export workers rather than inline calls in user-facing handlers.

## Level 3 — OntOS Application Runtime components

### Application Shell

The shell provides navigation, layout, tenant/legal-entity context selection, MicroVertical mounting points, shared design-system primitives, and cross-module affordances such as search, resource detail, timeline, and media attachment entry points.

### Module Runtime

The runtime discovers allowlisted OntOS Module Manifests, validates the active Application Composition DAG, checks activation state per Tenant, and exposes public Actions, APIs, components, resource contracts, search, and reports. Deployment installation and Tenant activation remain separate. Adding new code requires a new module delivery-unit build and deployment.

### Core Runtime Services

Core runtime services include BetterAuth binding, principal context, authorization adapter, business policy layer, tenant-level module state, action invocation recording, audit/event/outbox recording, media asset/link services, search index entries, worker checkpoints, and projection descriptors.

### MicroVertical Packages

Each MicroVertical package contains the implementation for one business capability: UI, state, routes, Actions, handlers, domain tables, resource/link implementation, permissions, migrations, report/search implementation, fixtures, and tests. The OntOS Module Manifest serializes only safe public descriptors. Other modules call published typed clients or consume outbox schemas; they never import private implementations or access another module's database.

### Action Execution Pipeline

The action execution pipeline receives action invocations from UI, API, imports, or integrations. It resolves the principal and context, checks module state, checks authorization, evaluates business policy, invokes the command handler, and records the necessary audit/domain/outbox records.

## Level 3 — Worker Runtime components

### Outbox Dispatcher

Reads pending outbox messages, claims work idempotently, dispatches to registered handlers, tracks attempts, handles retries, and moves failed messages into a dead-letter state.

### Projection Workers

Maintain Neo4j graph projection, search documents, resource cards, timelines, and reporting aggregates. They are replayable and should tolerate being behind canonical state.

### Import/Export Workers

Handle accounting exports, bank statement imports, future e-shop imports, and other long-running jobs. They should write controlled state transitions back through appropriate actions or explicit worker-owned state machines.

## Level 4 — Code view

A code-level view should be created only after the PoC establishes the actual UltraModern.js project structure. Prematurely defining final folders/packages risks constraining the PoC. The important code-level constraints for now are: MicroVerticals must remain cohesive vertical slices, Core must not import business module internals, and business modules must not mutate each other’s domain tables directly.
