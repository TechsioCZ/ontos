# ADR-0006: Explicit domain tables plus ResourceRef

Status: Accepted

## Context

OntOS needs cross-module linking without destroying domain integrity. A single generic JSON/EAV table would be flexible but weak for ERP constraints, billing, exports, and reporting. Direct foreign keys between every module pair would create tight coupling.

Earlier drafts proposed a central Core entity registry and typed relation edges. That would make Core own too much business topology and would make module evolution too rigid.

## Decision

Use explicit Postgres domain tables for operational data. Store cross-module links and Core projection targets as value-based `ResourceRef` values shaped as `tenant_id + module_key + resource_type + resource_id`.

Do not introduce `core.entities`, `core.relations`, or a central Core relation registry in V0. If a relationship carries business meaning, model it in the owning module or Foundational Module.

## Consequences

Modules can keep strong domain models while still being addressable by audit, media links, search, events, outbox payloads, graph projections, and other modules.

Core stays small: it stores ResourceRef values where it needs to point at a resource, but it does not own the target resource lifecycle or relation semantics.

Neo4j can project selected module-owned resources and ResourceRef/domain links later. Search and timelines can operate across modules through projections and module-owned resolvers.

## Risks

The team must define conventions for stable `resource_type` and `resource_id` values. If modules expose unstable identifiers, cross-module references become brittle.

The lack of a central relation registry means graph exploration starts less generic. That is intentional for V0; richer graph semantics should be added only when real workflows prove they need it.
