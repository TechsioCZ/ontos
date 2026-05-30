# ADR-0006: Explicit domain tables plus entity registry

Status: Proposed

## Context

TERP needs cross-module linking without destroying domain integrity. A single generic JSON/EAV table would be flexible but weak for ERP constraints, billing, exports, and reporting. Direct foreign keys between every module pair would create tight coupling.

## Decision

Use explicit Postgres domain tables for operational data. Register full business entities in a central entity registry. Store cross-module links as typed relation edges using stable entity references.

## Consequences

Modules can keep strong domain models while participating in the company ontology. Neo4j can project the registry and relation edges. Search and timelines can operate across modules.

## Risks

The team must define criteria for full entities vs child rows. If everything becomes an entity, the graph becomes noisy and expensive.
