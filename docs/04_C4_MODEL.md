# C4 model

This document uses C4 as a thinking structure, not as a rigid drawing format. UltraModern.js MicroVerticals intentionally include UI and backend behavior together while preserving strict independent deployment seams. OntOS Business Modules normally use that implementation shape; local and network Adapters preserve the same published interface.

Mermaid Markdown diagrams are in `diagrams/`. The prose below is authoritative; diagrams are support artifacts.

## Level 1 — System Context

OntOS is the encompassing modular business product used by internal operators, portal customers, accountants, administrators, and external operational roles. ERP and Commerce are Application Compositions of OntOS Foundational and Business Modules. Commerce is one shared B2C/B2B backend first configured for Akros and then N1.

The external systems around OntOS include Symmy, accounting software behind Symmy, bank statement sources, customer reservation websites, object storage, payment and delivery providers, and specialist systems such as Pulsar Solutions.

The system boundary is important. OntOS owns Core, reusable business capabilities, the Commerce Storefront API, Portal Account registration/authentication, Commerce Operations, and the canonical facts assigned to its modules. Independently deployed Storefront Applications, their local BFF/proxies, statutory accounting software, Symmy, and specialist machine-prediction platforms remain outside the standard OntOS deployment.

## Level 2 — Containers

### OntOS Shell and MicroVertical delivery units

The Shell composes installed, authorized module contributions from allowlisted serialized deployment contracts. Each MicroVertical delivery unit contains one Foundational or Business Module's UI, Actions, handlers, schema, and private owner-local runtime registration and remains independently deployable. Co-location is a Deployment Topology choice, not a change in logical ownership or trust.

Each delivery unit is where the MicroVertical implementation concept lives. It owns UI, actions, backend behavior, domain model declarations, migrations, tests, and public descriptors. Its public activation and cross-module contract is declared through the OntOS Module Manifest and projected into a safe serialized deployment contract.

### Commerce channel and operations applications

The thin Commerce Storefront API is an OntOS channel edge over public module contracts. Each external Storefront Application reaches it through a storefront-local BFF/proxy and a distinct tenant-bound Storefront Client credential, while a separate portal session or bounded guest context identifies the shopper. A temporary Medusa Store Compatibility Facade may translate existing hook shapes; native Commerce contracts remain authoritative.

Commerce Operations is a purpose-built staff application over public module Actions and the staff Shell authentication boundary. It is not the Shell, Core, or an alternative fact owner. Future MCP/UCP Agentic Shopping Adapters sit beside the Storefront API over native contracts.

### Module-owned Worker Processes

Core owns Outbox delivery state, leases, attempts, retries, dead letters, and checkpoints. Each consuming module owns its executable worker registration and handler inside its deployment. Worker processes consume only published schemas and remain operationally separate from user-facing requests; co-location does not turn them into centrally registered Shell/Core executables.

### Postgres

Postgres stores canonical operational truth: module-owned domain tables, Core runtime tables, audit events, domain events, outbox messages, media metadata/links, search projection entries, invoices, contracts, reservations, tickets, and accounting/export state.

### Neo4j

Neo4j stores a replayable graph projection of module-owned resources, selected ResourceRefs, and domain-specific relationships. It supports graph traversal, impact analysis, visual exploration, and future AI context. It is not the source of truth for operational ERP decisions in V0.

### SpiceDB

SpiceDB stores authorization relationships and answers permission questions. It is not the business ontology graph. Its model should remain focused on access: tenants, legal entities, roles, modules, resources, explicit grants, and relationship-derived access.

### Object Storage

Object storage stores file blobs. OntOS keeps media metadata, links, permissions-relevant context, timeline, and audit in Postgres.

### External Systems

External systems include Symmy, accounting software, banks/statement files, reservation websites, payment/delivery providers, and future Pulsar integration. One Integration Route is chosen per system and fact family: One-time Migration, a Symmy Route, or an owner-local Direct Provider Route. Integrations should normally be mediated by module-owned outbox/import/export workers rather than inline calls in user-facing handlers. Transport does not grant authority.

## Level 3 — OntOS runtime components

### Application Shell

The shell provides navigation, layout, tenant/legal-entity context selection, MicroVertical mounting points, shared design-system primitives, and cross-module affordances such as search, resource detail, timeline, and media attachment entry points.

### Module Runtime

The Shell/Core runtime discovers allowlisted serialized deployment contracts, builds the Installed Module Catalog atomically, validates the active Application Composition DAG, checks activation state per Tenant, and routes governed public Actions, APIs, components, resource contracts, search, and reports. It never imports another deployment's private manifest source or runtime registration. Deployment installation and Tenant activation remain separate.

### Core Runtime Services

Core runtime services include staff BetterAuth binding, principal context, authorization adapter, business policy layer, tenant-level module state, action invocation recording, audit/event/outbox recording, media asset/link services, search index entries, worker checkpoints, and projection descriptors. Commerce owns its separate Portal Account BetterAuth realm and links its accounts to tenant-scoped Principals and Party/Counterparty references through governed contracts.

### MicroVertical Packages

Each MicroVertical package contains the implementation for one business capability: UI, state, routes, Actions, handlers, domain tables, resource/link implementation, permissions, migrations, report/search implementation, fixtures, and tests. The OntOS Module Manifest serializes only safe public descriptors. Other modules call published typed clients or consume outbox schemas; they never import private implementations or access another module's database.

### Action Execution Pipeline

The action execution pipeline receives action invocations from UI, API, imports, or integrations. It resolves the principal and context, checks module state, checks authorization, evaluates business policy, invokes the command handler, and records the necessary audit/domain/outbox records.

## Level 3 — Worker Runtime components

### Outbox Delivery Runtime

Matches pending Outbox Messages to declared schema-only subscriptions, creates delivery work, tracks attempts and leases, handles retries, and moves failed deliveries into a dead-letter state. Owner processes claim work and invoke only their private handlers.

### Projection Workers

Maintain Neo4j graph projection, search documents, resource cards, timelines, and reporting aggregates. They are replayable and should tolerate being behind canonical state.

### Import/Export Workers

Handle accounting exports, bank statement imports, future e-shop imports, and other long-running jobs. They should write controlled state transitions back through appropriate actions or explicit worker-owned state machines.

## Level 4 — Code view

A code-level view should be created only after the PoC establishes the actual UltraModern.js project structure. Prematurely defining final folders/packages risks constraining the PoC. The important code-level constraints for now are: MicroVerticals must remain cohesive vertical slices, Core must not import business module internals, and business modules must not mutate each other’s domain tables directly.
