# Glossary

This glossary is part of the architecture. Terms should not be treated as cosmetic. If two people use the same word differently, the architecture will drift.

## OntOS

OntOS is the canonical name for the encompassing modular product. It contains Core, the Shell and operational runtimes, and reusable Foundational and Business Modules. ERP and Commerce are Application Compositions inside OntOS, not sibling products or forks of Core.

## OntOS Core

OntOS Core is the set of system capabilities that ordinary OntOS Business Modules depend on. It is not itself a business module. It includes tenant and legal-entity boundaries, principal context, BetterAuth binding, SpiceDB adapter, policy layer, tenant-level module state, action invocation recording, audit, events, outbox, media asset/link infrastructure, search index entries, worker checkpoints, reporting foundations, and projection interfaces.

Core is not meant to be disabled per tenant in the same way business modules can be. Some Core capabilities may have configuration or feature flags, but the kernel-level concepts are part of the runtime contract.

## UltraModern.js MicroVertical

An UltraModern.js MicroVertical is a framework-level full-stack vertical slice behind a strict independently deployable seam. It keeps frontend and backend parts of a capability together: routes, screens, components, state, Actions, handlers, domain model, migrations, tests, fixtures, public resource descriptors, permissions, report descriptors, search descriptors, and projection descriptors.

The framework concept does not define an OntOS manifest by itself. OntOS uses MicroVerticals as the likely implementation shape for business modules in V0.

A MicroVertical may be co-located with other deployments, but it must remain deployable to another server or process through configuration or Adapter selection only. Its purpose is to keep domain slices cohesive and independently understandable while preserving a real failure and deployment seam. It is not a separate OntOS product.

Examples: `internal.delivery`, `property.registry`, `property.long_term_rental`, `property.short_term_rental`, `billing.core`, `accounting.office`, `documents.center`, `facility.basic`.

## OntOS Business Module

An OntOS Business Module is a product/business capability in OntOS, usually implemented as an UltraModern.js MicroVertical in V0. A business module has a public OntOS Module Manifest so Core, activation logic, tooling, and other modules can reason about its public contract.

## Foundational Module

A Foundational Module is an OntOS Business Module that models shared business reality used by multiple other modules, but is not part of the Core Kernel. A Foundational Module may be active for most tenants and required by other modules, but it remains outside Core because it owns domain concepts that can evolve with customer discovery.

Example: `organization.registry`.

## Application Composition

An Application Composition is a named, reusable, versioned, dependency-closed directed acyclic graph of OntOS Foundational and Business Modules serving a coherent business purpose. It defines required modules, permitted optional modules, and dependency rules. Core validates and gates the graph generically. Commerce is one Application Composition shared by Akros, N1, and later commerce customers.

## Customer Configuration

A Customer Configuration is a declarative customer-specific configuration of an Application Composition. It may select permitted optional modules and define policies, settings, branding, locales, Connectors, and integration participation. It must not fork Core, alter shared module contracts, or create customer-specific module implementations. Akros and N1 are Customer Configurations of Commerce.

## Environment

An Environment is a topology-neutral lifecycle context for a Customer Configuration, such as Production, Staging, or Development. It does not imply geography, data residency, customer isolation, or shared multi-tenancy.

## Deployment Topology

Deployment Topology is the physical mapping of Customer Configurations, Environments, Tenants, modules, data stores, workers, and Channel Applications onto infrastructure. It owns isolation, multi-tenancy, placement, and regional/residency choices without changing the logical composition.

## Channel Application

A Channel Application is a customer- or partner-facing application that composes public Business Module contracts, such as a commerce Storefront. It may share the OntOS monorepo and deploy separately, but owns presentation and journeys rather than canonical business facts.

## System Module

A System Module is a Core-owned capability described with an OntOS Module Manifest or a narrower system-module variant for consistency, but it is not an ordinary business module. Examples include `core.identity`, `core.authz`, `core.modules`, `core.audit`, `core.events`, `core.outbox`, and `core.search`.

## OntOS Module Manifest

An OntOS Module Manifest is the OntOS-specific Effect Schema-defined public contract of an OntOS Business Module, Foundational Module, or selected System Module. It declares module identity, activation, dependencies, public APIs, public component exports, public resource types, public events, search descriptors, and report descriptors.

The manifest is not part of the standard UltraModern.js MicroVertical concept, and it is not an implementation manifest. It should rely on typed values and inference rather than manually-authored import/export strings. It should not declare database tables, migrations, command handler paths, outbox handler paths, route trees, navigation wiring, fixtures, tests, private imports, the SpiceDB permission model, or a static relation catalog.

## OntOS Application Runtime

The OntOS Application Runtime is a logical composition of the Shell, Core capabilities, and installed MicroVertical delivery units. MicroVerticals intentionally combine frontend and backend concerns into one business slice while preserving independent deployment. The logical runtime does not require one physical process or one customer deployment.

## OntOS Worker Runtime

The OntOS Worker Runtime is a separate process or set of processes for asynchronous work: outbox processing, Neo4j projections, search projections, reporting refreshes, import/export tasks, scheduled jobs, and future integration workers. It consumes events/outbox messages emitted by the application runtime. It should not own canonical business state except for controlled state transitions related to its work, such as marking an export as completed.

## Action

An Action is the public business operation exposed by an OntOS Business Module. It is the unit that UI, API calls, imports, integrations, and later agents invoke. Actions are declared in the OntOS Module Manifest and are subject to authentication, authorization, policy checks, module state checks, validation, audit, and command handling.

Examples: create reservation, issue invoice, attach media/document, link resources, activate module, create lease contract, create ticket.

## Command Handler

A Command Handler is the implementation of an Action. It performs validation and writes canonical state in Postgres in a transaction. It also records audit events, domain events, and outbox messages as part of the same transactional boundary.

## Domain Event

A Domain Event records a business fact that already happened. It is not the primary mechanism for changing business state. Domain events are used to explain history and trigger asynchronous projections or follow-up work.

## Audit Event

An Audit Event records who or what did something, when, under which principal, from which context, and why it was allowed or denied. Audit events are evidence. They should not be used as workflow triggers.

## Outbox Message

An Outbox Message is a delivery mechanism for asynchronous side effects. It is written in the same Postgres transaction as the business state change and later processed by workers. This avoids dual-write inconsistency between the database and external side effects.

## Resource

A Resource is a module-owned business or system object with durable identity over time. Full resources may be addressable, searchable, linkable, auditable, and visible in projections. Not every database row is a Resource.

## ResourceRef

A ResourceRef is the value reference used when Core or another module needs to point at a module-owned resource without owning that resource. The canonical shape is `tenant_id + module_key + resource_type + resource_id`.

ResourceRefs are not backed by a central Core entity registry. The owning module keeps canonical tables, constraints, lifecycle, and business rules.

## Resource Link

A Resource Link is a domain-specific link stored by the module or cross-cutting table that needs it. Links should use `ResourceRef` values across module boundaries rather than physical foreign keys.

There is no central Core relation registry in V0. If a relationship carries business meaning, the owning module should model it explicitly.

## Organization Registry

Organization Registry is the Foundational Module that models shared organizational business structure such as legal-entity groups, holdings, portfolios, acquisition batches, and similar views over managed Legal Entities. In V0 it is a group/view model, not a corporate ownership or control ledger.

## Canonical Store

The Canonical Store is the source of truth for operational ERP state. For V0 this is Postgres. Neo4j, search indexes, and reports are projections/read models.

## Projection

A Projection is derived state built from canonical state and events. Neo4j graph nodes/relationships, search documents, reporting aggregates, and resource cards are projections. A projection must be rebuildable.

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

## Symmy Connector

The Symmy Connector is the single OntOS-to-Symmy integration seam. OntOS Business Modules publish provider-neutral business handoff contracts; the Connector adapts those contracts without owning their business facts or lifecycle authority. It is outside Core.

## Symmy–Provider Integration

A Symmy–Provider Integration is a provider-specific integration operated downstream through Symmy, such as Symmy–POHODA Integration or Symmy–ABRA Integration. N1's current direct POHODA integration is legacy and migration evidence, not the target OntOS architecture.

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

Neo4j Projection is an optional graph projection of module-owned resources, selected ResourceRefs, and domain-specific relationships for graph traversal, impact analysis, visual exploration, and future semantic/AI context. It is not the canonical ERP store in V0.

## Forge

Forge is an internal developer tool for generating MicroVertical skeletons and keeping agent-generated work inside consistent boundaries. It is not the user-facing vibemodule.

## Vibemodule

Vibemodule is a future user-facing capability where new modules can be generated or configured from higher-level descriptions. It requires the OntOS Module Manifest, ResourceRef conventions, actions, permissions, migrations, and tests to be mature first. It is not V0 scope.
