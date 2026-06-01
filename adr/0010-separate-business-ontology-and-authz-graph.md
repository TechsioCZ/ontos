# ADR-0010: Separate business ontology graph and authorization graph

Status: Proposed

## Context

OntOS uses both business entity relationships and authorization relationships. Neo4j and SpiceDB both represent graphs, but they solve different problems.

## Decision

Business ontology relationships are canonical in Postgres entity edges and projected to Neo4j. Authorization relationships are stored in SpiceDB. The two graphs may reference the same concepts, but they are not the same graph.

## Consequences

Neo4j answers relationship/exploration questions. SpiceDB answers permission questions. This avoids mixing semantic business links with access-control decisions.

## Risks

Developers may attempt to reuse Neo4j for permissions or SpiceDB for business ontology. Documentation and adapters should make that difficult.
