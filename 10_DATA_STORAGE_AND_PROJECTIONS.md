# Data storage and projections

OntOS deliberately uses multiple data stores, each with a clear responsibility. This is not polyglot persistence for prestige; it exists because operational ERP data, graph exploration, authorization, and file blobs have different shapes.

## Postgres

Postgres is the canonical operational store. It should contain module-owned domain tables, Core runtime tables, tenant-level module state, audit events, domain events, outbox, media asset/link metadata, search index entries, invoices, reservations, lease contracts, payments, cost records, accounting export state, internal dogfood resources, and current state needed for transactional operations.

Postgres is where constraints, indexes, migrations, accounting/reporting queries, and auditability must be reliable.

## Neo4j

Neo4j is an optional graph projection of the company ontology. It may become useful for multi-hop relationships, impact analysis, visual exploration, and future AI context. It should be rebuilt from Postgres if introduced. It should not be required to issue an invoice, create a lease, create a reservation, or enforce core permissions in V0.

The projection should include selected module-owned resources, ResourceRef links, and domain-specific relationships, plus denormalized display/status/type/module/tenant fields where useful. Avoid dumping all child rows or large sensitive payloads into Neo4j by default.

## SpiceDB

SpiceDB is the authorization store. It stores relationship tuples and permission schema. It should be fed by deliberate access-management actions, not by blindly mirroring every business relation. OntOS treats SpiceDB as foundation-level infrastructure because hand-rolled authorization creates too many failure points.

## Object storage

Object storage holds binary file content. Media metadata, links, processing state, relevant permission context, expiration, versions, and audit live in Postgres. A file blob without a media asset row is not an OntOS-managed asset.

Object storage keys should be technical, collision-resistant identifiers such as UUID/ULID-based keys, not user filenames. User/source filenames belong in Postgres media metadata:

- `original_filename`: the filename received from the browser, import, integration, or external system. It is provenance metadata and may be null.
- `display_filename`: the sanitized filename OntOS uses for UI and download headers.

Do not derive authorization, uniqueness, tenant ownership, or folder hierarchy from filenames. Filenames can collide, contain sensitive text, contain unsafe path characters, and change for presentation reasons. Storage identity is `storage_provider + storage_key`; human naming is metadata.

## Search index

The first search implementation may be Postgres-based. The architecture should still treat search documents as projections because later search may move to a dedicated engine. Search documents should include tenant, legal entity, module, resource type, display fields, searchable text, facets, and timestamps.

Search authorization should be enforced through SpiceDB list-filtering patterns rather than a separate OntOS access class. Use `LookupResources` when the accessible result set is modest, `CheckBulkPermissions` when filtering candidate pages is more appropriate, and consider a materialized permission view only when measured scale requires it.

## Projection lag

Projection lag is acceptable for Neo4j, search, and reporting if surfaced appropriately. It is not acceptable for canonical billing or audit. Workers should record projection status and support replay/rebuild.

## Rebuildability

All projections must be rebuildable from canonical state. This includes Neo4j graph, search documents, resource cards, timelines where derived, and reporting aggregates. The system should not require manual database surgery to recover from projection corruption.
