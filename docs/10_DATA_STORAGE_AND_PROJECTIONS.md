# Data storage and projections

OntOS deliberately uses multiple data stores, each with a clear responsibility. This is not polyglot persistence for prestige; it exists because operational ERP data, graph exploration, authorization, and file blobs have different shapes.

## Postgres

Postgres is the canonical operational store. It should contain module-owned domain tables, Core runtime tables, tenant-level module state, audit events, domain events, outbox, media asset/link metadata, search index entries, invoices, reservations, lease contracts, payments, cost records, accounting export state, internal dogfood resources, and current state needed for transactional operations.

Postgres is where constraints, indexes, migrations, accounting/reporting queries, and auditability must be reliable.

Every vertical that owns database tables must have its own Postgres schema. Core-owned tables live in `core`, BetterAuth tables live in `auth`, and vertical-owned tables live in that vertical's schema, such as `property` or `accounting`. The `public` schema is not a home for OntOS application tables.

All application database interaction must use Drizzle together with Effect unless a specific decision explicitly states otherwise. Raw SQL is reserved for schema/bootstrap work or narrowly documented cases where Drizzle cannot express the required database behavior clearly.

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

Do not derive authorization, uniqueness, tenant ownership, or folder hierarchy from filenames. Filenames can collide, contain sensitive text, contain unsafe path characters, and change for presentation reasons. Storage identity is `storage_provider + storage_key` plus `storage_object_version_ref` when the provider exposes object versions/generations; human naming is metadata.

`content_sha256` is the SHA-256 hash of the exact stored bytes. It is content identity, not metadata. It may be null only while upload/ingest is incomplete. After upload/ingest is complete and the media asset is sealed, `storage_key`, `storage_object_version_ref`, `byte_size`, and `content_sha256` must be present and immutable. Presentation metadata such as `display_filename`, processing state, detected metadata, previews, and links may still change without changing the content identity.

WORM/Object Lock belongs to the storage provider, not to Postgres. For evidence that needs strong legal/compliance posture, the upload/evidence workflow should set or rely on provider-side retention/legal hold/bucket lock, read the provider metadata back, and record the result on `CORE_EVIDENCE_REFERENCES`. If the provider does not support storage-level immutability, OntOS can only mark the evidence as `application_only`: protected by OntOS APIs, audit, credentials, and DB constraints, but not by provider-enforced WORM.

`CORE_MEDIA_ASSETS` needs both `created_at` and `updated_at` because media metadata can change after ingest: `display_filename`, processing state, detected MIME metadata, preview readiness, or external source references may be corrected without changing the underlying storage object.

`CORE_MEDIA_LINKS` connects a stored media asset to a target ResourceRef. `linked_by_principal_id` stores the effective actor that created the link. For support/admin impersonation, do not duplicate impersonation columns into the link row; user/support-created links should require `action_invocation_id`, and the joined action invocation provides `auth_method`, `auth_context_ref`, and optional `impersonated_by_principal_id`.

`link_kind` is module-scoped constrained text, not a globally exhaustive enum and not arbitrary user text. The target module should define allowed values for the target resource type, such as `attachment`, `photo`, `contract_scan`, `invoice_pdf`, `source_file`, or `preview`. Do not use `link_kind = evidence` for compliance evidence; durable audit/compliance evidence belongs in `CORE_EVIDENCE_REFERENCES`.

## Search index

The first search implementation may be Postgres-based. The architecture should still treat search documents as projections because later search may move to a dedicated engine. Search documents should include tenant, legal entity, module, resource type, display fields, searchable text, facets, and timestamps.

Search authorization should be enforced through SpiceDB list-filtering patterns rather than a separate OntOS access class. Use `LookupResources` when the accessible result set is modest, `CheckBulkPermissions` when filtering candidate pages is more appropriate, and consider a materialized permission view only when measured scale requires it.

## Projection lag

Projection lag is acceptable for Neo4j, search, and reporting if surfaced appropriately. It is not acceptable for canonical billing or audit. Workers should record projection status and support replay/rebuild.

## Rebuildability

All projections must be rebuildable from canonical state. This includes Neo4j graph, search documents, resource cards, timelines where derived, and reporting aggregates. The system should not require manual database surgery to recover from projection corruption.
