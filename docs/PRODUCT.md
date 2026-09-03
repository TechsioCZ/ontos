# OntOS product

OntOS is one modular business product for operating organizations whose important facts, actions,
relationships, permissions, and evidence need clear ownership. It is intended to replace
scattered spreadsheets, paper, disconnected applications, and fragile customer-specific software with
cohesive capabilities that can evolve without weakening shared runtime guarantees.

## Product shape

- Core and Shell provide business-neutral guarantees for identity, tenant and legal-entity scope,
  module state, governed operations, authorization, policy, audit, events, outbox delivery, media,
  search foundations, and runtime composition.
- Foundational Modules own shared business reality, such as Party identity, without pulling domain
  behavior into Core.
- Business Modules own complete business capabilities and data lifecycles behind independently
  deployable MicroVertical seams.
- Application Compositions assemble compatible modules for a coherent purpose. Customer
  Configuration selects permitted options and policies without creating hidden forks.

Product discovery spans shared identity and Contacts, flexible Projects work management, and a
reusable B2C/B2B Commerce composition. These areas share Core guarantees but retain distinct
domain ownership. A customer deployment is evidence about real needs; it does not become a
separate product or silently redefine shared architecture.

## Product principles

- Business state changes through declared Actions; committed facts drive asynchronous work.
- Operational facts remain canonical in module-owned PostgreSQL data.
- Cross-module references preserve ownership instead of creating shared tables or private imports.
- Authentication, authorization, and business policy remain separate decisions.
- Historical data, audit, and evidence remain recoverable when a module is inactive or replaced.
- Customer-specific behavior is declarative or an explicitly catalogued implementation, never an
  invisible fork under an existing identity.
- Architecture exists to deliver understandable business outcomes, not to create a generic plugin,
  workflow, ontology, or control-plane platform.

## Boundaries

OntOS does not commit to an exhaustive generic ERP module catalog. Unvalidated module wishlists
are discovery input, not scope. Statutory accounting stays in specialist accounting systems;
OntOS may own operational evidence, billing facts, approvals, and explicit integration handoffs.

User-facing autonomous agents, generalized low-code generation, a generic workflow engine, and
machine-prediction technology are not product foundations. They may integrate through public
Actions, resources, evidence, and external contracts when a validated use case requires them.

## Product grounding

Product direction is grounded in observed customer deliveries, existing production systems,
internal operational needs, and focused discovery. These sources provide evidence, not automatic
requirements. This document owns top-level product shape and boundaries; focused contexts own
accepted domain semantics, ADRs own durable architecture, and GitHub issues own open decisions,
scheduling, and prioritization.
