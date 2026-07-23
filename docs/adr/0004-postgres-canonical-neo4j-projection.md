# ADR-0004: Postgres is canonical; Neo4j is an optional projection

Status: Accepted

## Context

The long-term vision depends on graph exploration, but V0 ERP operations require reliable transactional storage, constraints, migrations, billing, accounting exports, and audit.

## Decision

Postgres is the canonical operational source of truth. Neo4j, if included in V0, is a replayable graph projection of module-owned resources, selected ResourceRefs, and domain-specific relationships. Module-owned tables and Core projection records must stand on their own without Neo4j.

## Consequences

ERP operations do not depend on Neo4j availability or even on Neo4j being present. Graph views may be eventually consistent. Neo4j can be introduced later and rebuilt from Postgres, ResourceRefs, and domain events.

## Risks

If application code starts making operational decisions based only on Neo4j, the model breaks. That must be prohibited for V0. The remaining risk is delaying graph feedback too long and discovering too late that selected ResourceRef/domain link semantics are too weak for useful traversal.
