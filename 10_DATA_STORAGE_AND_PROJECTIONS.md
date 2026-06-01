# Data storage and projections

OntOS deliberately uses multiple data stores, each with a clear responsibility. This is not polyglot persistence for prestige; it exists because operational ERP data, graph exploration, authorization, and file blobs have different shapes.

## Postgres

Postgres is the canonical operational store. It should contain domain tables, entity registry, relation edges, module installations, audit events, domain events, outbox, document metadata, invoices, reservations, lease contracts, payments, cost records, accounting export state, internal dogfood entities, and current state needed for transactional operations.

Postgres is where constraints, indexes, migrations, accounting/reporting queries, and auditability must be reliable.

## Neo4j

Neo4j is an optional graph projection of the company ontology. It may become useful for multi-hop relationships, impact analysis, visual exploration, and future AI context. It should be rebuilt from Postgres if introduced. It should not be required to issue an invoice, create a lease, create a reservation, or enforce core permissions in V0.

The projection should include entity nodes and typed relation edges, plus selected denormalized display/status/type/module/tenant fields. Avoid dumping all child rows or large sensitive payloads into Neo4j by default.

## SpiceDB

SpiceDB is the authorization store. It stores relationship tuples and permission schema. It should be fed by deliberate access-management actions, not by blindly mirroring every business relation. OntOS treats SpiceDB as foundation-level infrastructure because hand-rolled authorization creates too many failure points.

## Object storage

Object storage holds binary file content. Document metadata, links, ownership, permissions, expiration, versions, and audit live in Postgres. A file blob without a document metadata entity is not a business document in OntOS.

## Search index

The first search implementation may be Postgres-based. The architecture should still treat search documents as projections because later search may move to a dedicated engine. Search documents should include tenant, legal entity, module, entity type, display fields, searchable text, facets, updated timestamp, and permission/access-class fields.

## Projection lag

Projection lag is acceptable for Neo4j, search, and reporting if surfaced appropriately. It is not acceptable for canonical billing or audit. Workers should record projection status and support replay/rebuild.

## Rebuildability

All projections must be rebuildable from canonical state. This includes Neo4j graph, search documents, entity cards, timelines where derived, and reporting aggregates. The system should not require manual database surgery to recover from projection corruption.
