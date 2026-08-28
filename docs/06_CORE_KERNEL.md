# Core Kernel

The Core Kernel provides the system capabilities that make MicroVerticals safe, consistent, and extensible. It is not a business module and should not contain property-specific, billing-specific, or internal-operator-specific business logic except through generic infrastructure.

## Core responsibilities

Core owns the runtime concepts that every module depends on: tenant/legal-entity context, principal context, BetterAuth binding, authorization integration, policy evaluation hooks, tenant-level module state, action invocation recording, audit events, domain events, outbox, media asset/link infrastructure, search index entries, worker checkpoints, projection interfaces, and common operational observability.

Core is the reason MicroVerticals can be cohesive without becoming isolated. It gives them shared semantics for identity, actions, ResourceRefs, media links, permissions, audit, and projections.

## What belongs in Core

| Capability | Belongs in Core? | Reason |
|---|---:|---|
| Principal model | Yes | All actors need common identity representation. |
| Tenant/legal-entity context | Yes | Isolation and reporting cut across modules. |
| BetterAuth integration | Yes | Authentication is system-level. |
| SpiceDB adapter | Yes | Authorization decisions must be consistent. |
| Policy hook framework | Yes | Business policies require common enforcement points. |
| Module state | Yes | Activation state is tenant-level runtime configuration. |
| Action invocation governance and descriptor catalog | Yes | All writes use governed owner-local Actions without importing their handlers. |
| ResourceRef convention | Yes | Cross-module references need a common value shape, but not a central business registry. |
| Audit and domain event recording | Yes | Evidence and event history must be consistent. |
| Outbox | Yes | Side-effect dispatch must be consistent. |
| Media asset/link foundation | Yes | Uploaded files and extracted media must link to any resource without owning it. |
| Search interface | Yes | Search spans modules and permissions. |
| Graph projection interface | Yes | Graph projection may span modules even if Neo4j is introduced later. |

## What does not belong in Core

Core should not know how to calculate rent, how to create a reservation, how to map an internal delivery ticket to an invoice line source, how to decide short-term cancellation policy, or how to shape an accounting export for a specific accounting system. Those are OntOS Business Module or integration responsibilities.

A common failure mode is to put business logic into Core because two modules need something similar. The safer approach is to create explicit shared abstractions only after the second real use case proves they are the same concept. Premature generic Core logic will become harder to change than module code.

## Core as system modules

Core capabilities may be described with OntOS Module Manifests or a narrower system-module variant for consistency, but they are not ordinary business modules. For example, `core.audit` can declare public audit event structures, `core.media` can declare media asset/link structures, and `core.search` can declare search index entry structures.

The key difference is activation. Business modules can be active/read-only/suspended/quarantined per tenant. Kernel capabilities cannot simply be suspended without compromising the system. They can have configuration and feature flags, but not ordinary customer-level module off switches.

## Core extension points

Core exposes narrow data and invocation extension points to modules: serialized deployment-contract discovery, public Action/API/component/resource/event/search/report descriptors, permission and Policy references, structured entrypoint gateways, and Outbox delivery contracts. These surfaces let Core validate, gate, route, and observe calls without acquiring business implementation.

Executable Actions, Policies, migrations, handlers, workers, repositories, routes, search implementations, reports, and private registrations stay inside the owning MicroVertical deployment. Shell/Core must not import another deployment's `vertical.manifest.ts`, `vertical.registration.ts`, or private source. It builds the Installed Module Catalog from allowlisted serialized contracts and invokes the owner through governed entrypoints and published clients.

These extension points need to be explicit because they are the future foundation for Forge and later vibemodule capabilities. If modules can mutate runtime behavior through ad hoc imports, central executable registration, or global side effects, generation and review become impossible.

Shell/Core gateways must be the only way to invoke module entrypoints. Page loads, public component loads, Actions, and worker dispatch all pass through the Module State Gate before Shell/Core loads or dispatches the target module entrypoint.

## Core should be boring

The Core should not be a showcase for every future ambition. It should be small, strict, and testable. It should enforce invariants: all writes through actions, all actions authorized, cross-module references use ResourceRefs, all important changes are audited, all asynchronous side effects go through outbox, and all tenant-level module states are respected.
