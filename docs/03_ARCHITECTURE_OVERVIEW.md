# Architecture overview

OntOS is one modular product with strong full-stack vertical slices. Each OntOS Business Module is normally implemented as an UltraModern.js MicroVertical that includes UI and backend behavior together behind a strict independently deployable seam, while Core provides common runtime capabilities. Co-location remains possible, but moving a MicroVertical must not require changes to consuming business logic.

## Architectural position

The system is not a generic microservice platform. MicroVerticals have real deployment seams enforced by OntOS Module Manifests, published typed clients, Module Federation wrappers, outbox contracts, package ownership, dependency rules, runtime registries, tests, and ADRs. A module may run co-located or remotely without changing its callers.

The system is not pure event-driven architecture. State changes are initiated through registered Actions and implemented by Command Handlers. Events and outbox messages are emitted as consequences of successful commands and are used to maintain projections, exports, reports, and integrations.

The system is not a generic entity-store platform. Hard business objects such as invoices, leases, reservations, media assets, and tickets live in explicit Postgres domain tables owned by their modules. Cross-module addressability uses value-based `ResourceRef` values, not a central Core entity/relation registry.

The system is not an AI product in V0. It should be designed so AI can later consume resources, actions, domain links, media/documents, audit, and timelines, but no committed V0 feature should depend on user-facing AI.

## Runtime shape

The logical OntOS Application Runtime composes the Shell, Core, and installed MicroVertical delivery units. Those delivery units may run separately. Worker runtimes process asynchronous work. Postgres stores canonical state. Neo4j stores an optional graph projection. SpiceDB stores authorization relationships. Object storage stores file blobs. External accounting systems, reservation websites, banks, Symmy, and specialist systems such as Pulsar sit outside OntOS. Commerce Business Modules and the commerce back office are inside OntOS; Storefronts are Channel Applications over their public contracts.

This separation is important. MicroVertical cohesion is preserved while each vertical remains independently deployable. Contract-derived local and network Adapters preserve the same behavior across placement choices. Asynchronous work is isolated in workers because projections, exports, imports, notifications, and long-running tasks should not block user-facing command execution.

## Business Modules, MicroVerticals, and Core

An OntOS Business Module is a product/business capability slice. In V0 it is normally implemented as an UltraModern.js MicroVertical, so it can own both user experience and business behavior. For example, `property.short_term_rental` can own reservation screens, availability state, reservation actions, reservation command handlers, reservation domain tables, links to units/guests/invoices/documents, report descriptors, and tests.

Core owns capabilities that all business modules require and that should not be reimplemented in modules: tenant and legal-entity boundaries, principal mapping, authorization adapter, policy evaluation hooks, tenant-level module state, action invocation recording, audit, domain events, outbox, media asset/link infrastructure, search index entries, worker checkpoints, and common reporting/search foundations.

This gives us a clear rule: OntOS Business Modules own domain behavior; Core owns cross-cutting runtime guarantees.

## Data and consistency

Postgres is the canonical operational store. The core business transaction must write module-owned domain data, audit events, domain events, outbox messages, and any relevant `ResourceRef` projection records in the same transaction where appropriate. Neo4j and search indexes are updated asynchronously via outbox workers.

This means the system tolerates projection lag. A reservation created in Postgres is real even if Neo4j has not yet projected it. A graph view may be temporarily stale; billing and audit must not be.

## Permissions

Authentication and authorization are separate. BetterAuth handles authentication and sessions. An OntOS principal registry maps authenticated subjects into principals. SpiceDB answers relationship-based permission checks. The OntOS Policy Layer evaluates business conditions that are not purely relational.

Search and graph views must be permission-aware. V0 should use tenant, legal-entity, module, and resource-type scoping for candidate selection, then authorize through SpiceDB list-filtering patterns such as `LookupResources` or `CheckBulkPermissions`. A materialized permission view should be added only when measured scale requires it.

## Application compositions and delivery

An Application Composition is a versioned, dependency-closed DAG of Foundational and Business Modules. Commerce is one reusable composition; Akros and N1 are declarative Customer Configurations of it. Core validates installation, activation, and entrypoint dependency closure without learning commerce meaning. A dependency outage degrades affected entrypoints without cascading persisted states or disabling unrelated modules.

Production, Staging, and Development are topology-neutral Environments. Per-customer isolation, shared multi-tenancy, geography, data residency, and concrete module placement remain Deployment Topology choices. Symmy is the preferred, non-exclusive Integration Hub for provider families it supports; an owning module may use a Direct Provider Adapter when that family is intentionally outside Symmy or Symmy lacks the required integration.
