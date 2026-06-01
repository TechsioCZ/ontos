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
