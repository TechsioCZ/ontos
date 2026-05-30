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
| Neo4j projection interface | Yes | Graph projection spans modules. |

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
