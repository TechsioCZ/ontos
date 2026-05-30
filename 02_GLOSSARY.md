# Glossary

This glossary is part of the architecture. Terms should not be treated as cosmetic. If two people use the same word differently, the architecture will drift.

## TERP

TERP is the working name for the system. In V0 it is a delivery-bound ERP with platform-shaped foundations. In the long-term vision it becomes a temporal company ontology system with ERP MicroVerticals as the first application layer.

## TERP Core

TERP Core is the set of system capabilities that ordinary business MicroVerticals depend on. It is not itself a business MicroVertical. It includes authentication integration, principal context, authorization adapter, policy layer, module runtime, entity registry, relation registry, audit, events, outbox, document metadata services, search interfaces, reporting foundations, and projection interfaces.

Core is not meant to be disabled per tenant in the same way business MicroVerticals can be. Some Core capabilities may have configuration or feature flags, but the kernel-level concepts are part of the runtime contract.

## MicroVertical

A MicroVertical is a unified vertical slice of business capability inside the jointly deployable TERP application. A MicroVertical contains its frontend and backend parts together: routes, screens, components, state, actions, command handlers, domain model, migrations, tests, fixtures, entity declarations, relation declarations, permissions, report descriptors, search descriptors, and projection descriptors.

A MicroVertical is not a microservice in V0. It is a module boundary inside a modular monolith. Its purpose is to keep domain slices cohesive and independently understandable without introducing distributed-system overhead.

Examples: `internal.delivery`, `property.registry`, `property.long_term_rental`, `property.short_term_rental`, `billing.core`, `accounting.office`, `documents.center`, `facility.basic`.

## System Module

A System Module is a Core capability described with a manifest-like structure for consistency, but it is not an ordinary business MicroVertical. Examples include `core.identity`, `core.authz`, `core.modules`, `core.ontology`, `core.audit`, `core.events`, `core.outbox`, and `core.search`.

## Module Manifest

A Module Manifest is the declarative contract of a MicroVertical or System Module. It declares module identity, version, dependencies, owned entity types, relation types, actions, permissions, UI contributions, migrations, report descriptors, search descriptors, and projection handlers. The manifest is the primary artifact that allows the runtime, tooling, coding agents, and later Forge/vibemodule functionality to reason about a module.

## TERP Application Runtime

The TERP Application Runtime is the main deployable application container. It includes the app shell, MicroVertical UI, server-side module actions, command handlers, Core services, and HTTP/API entrypoints. It should not be modeled as a separate Web App plus BFF for architecture purposes, because MicroVerticals intentionally combine frontend and backend concerns into a single vertical slice.

## TERP Worker Runtime

The TERP Worker Runtime is a separate process or set of processes for asynchronous work: outbox processing, Neo4j projections, search projections, reporting refreshes, import/export tasks, scheduled jobs, and future integration workers. It consumes events/outbox messages emitted by the application runtime. It should not own canonical business state except for controlled state transitions related to its work, such as marking an export as completed.

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

A Legal Entity is a company/SRO/SPV/accounting-client inside a tenant. Many permissions, modules, invoices, documents, and reports are scoped to legal entities.

## Principal

A Principal is an actor that can be authenticated or represented in audit and authorization: user, agent, service account, integration, or system. In V0 agent principals may exist as foundations, but autonomous agent behavior is not product scope.

## BetterAuth

BetterAuth is the proposed authentication/session layer. It owns login/session mechanics and maps authenticated users into TERP principals. It should not be treated as the complete fine-grained authorization system.

## SpiceDB

SpiceDB is the proposed authorization graph. It models relationships and answers permission questions. It is not the business ontology graph.

## TERP Policy Layer

The TERP Policy Layer handles business conditions that are not pure relationship-based authorization: module state, locked accounting period, invoice already exported, amount thresholds, approval requirements, document sensitivity, and risk conditions.

## Neo4j Projection

Neo4j stores a graph projection of registered entities and typed relationships for graph traversal, impact analysis, visual exploration, and future semantic/AI context. It is not the canonical ERP store in V0.

## Forge

Forge is an internal developer tool for generating MicroVertical skeletons and keeping agent-generated work inside consistent boundaries. It is not the user-facing vibemodule.

## Vibemodule

Vibemodule is a future user-facing capability where new modules can be generated or configured from higher-level descriptions. It requires the MicroVertical manifest, entity registry, relation registry, actions, permissions, migrations, and tests to be mature first. It is not V0 scope.
