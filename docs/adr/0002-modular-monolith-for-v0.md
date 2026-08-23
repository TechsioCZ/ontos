# ADR-0002: V0 uses a modular monolith, not microservices

Status: Superseded on 2026-08-23 by the independently deployable MicroVertical contract in `app/docs/architecture/MICROVERTICALS.md`. Co-location remains allowed as Deployment Topology, but it is not a module-interface constraint.

## Context

The team is small, the delivery timeline is constrained, and the domain is still being discovered. Distributed services would increase deployment, debugging, schema evolution, observability, and operational complexity before the product has stable boundaries.

## Decision

OntOS V0 will be implemented as a TypeScript modular monolith/modulith using UltraModern.js MicroVerticals. Module boundaries are internal package/runtime boundaries, not network boundaries.

## Consequences

Local development, transactions, refactoring, and deployment remain simpler. Hot paths can be extracted later based on measurement. The architecture must still enforce module boundaries through OntOS Module Manifests, dependency rules, tests, and review.

## Risks

A modular monolith can degrade into a big ball of mud if boundaries are not enforced. The OntOS Module Manifest and dependency rules are therefore not optional.
