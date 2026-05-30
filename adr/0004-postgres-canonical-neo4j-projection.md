# ADR-0004: Postgres is canonical; Neo4j is a projection

Status: Proposed

## Context

The long-term vision depends on graph exploration, but V0 ERP operations require reliable transactional storage, constraints, migrations, billing, accounting exports, and audit.

## Decision

Postgres is the canonical operational source of truth. Neo4j is a replayable graph projection of entity registry rows and typed relation edges.

## Consequences

ERP operations do not depend on Neo4j availability. Graph views may be eventually consistent. Neo4j can be rebuilt from Postgres and domain events.

## Risks

If application code starts making operational decisions based only on Neo4j, the model breaks. That must be prohibited for V0.
