# Canonical entity model

TERP needs both strong domain modeling and universal cross-module linking. The chosen model is explicit Postgres domain tables plus a central entity registry and typed relation edges.

## Why not generic JSON/EAV

A generic `entities` table with arbitrary JSON payloads would make early prototyping look flexible, but it would damage ERP correctness. Billing, rental contracts, reservations, payments, accounting exports, reporting, constraints, indexes, migrations, and auditing need explicit structures. A generated/custom module layer may later use metadata-backed storage, but V0 core ERP data should not be built on generic JSON as the primary model.

## Why entity registry

Direct foreign keys between every possible module pair would tightly couple modules. For example, billing may need to link invoices to reservations, lease contracts, service tickets, documents, contacts, and internal delivery tickets. Hard foreign keys for every future relationship would create an expanding web of dependencies.

The entity registry gives each full business entity a stable identity. Modules can link to an `entity_ref` without importing the target module’s internal tables. The registry also supports global search, timeline, graph projection, and future AI context.

## Full entity vs child row

A full entity has independent business identity over time. It is addressable, searchable, linkable, auditable, and can appear in timelines, reports, and permissions. Examples include legal entity, property, building, unit, contact, lease contract, reservation, invoice, payment, document, service ticket, accounting export batch, client, project, and ticket.

A child row or value object exists inside a parent and should not be independently addressable by default. Examples include invoice lines, tax breakdown rows, price breakdown rows, payment schedule items, contact methods, checklist items, and export lines.

A child row can later be promoted into an addressable child entity if it develops its own lifecycle, permissions, document links, workflow, reporting, or external identity.

## Entity registry binding

A full entity should have a row in its domain table and a corresponding row in `entity_registry`. The domain table holds operational truth. The registry holds global identity and addressing metadata.

The registry should capture tenant id, entity type key, stable entity id, owning module, display name, lifecycle/status, legal-entity scope, storage binding, sensitivity/access class, timestamps, and current schema version.

The physical storage binding is an implementation detail. External references and cross-module links should use `entity_ref`, not raw table/id pairs as the public contract.

## Entity types

An entity type defines a kind of business entity. Examples include `property.unit`, `property.lease_contract`, `property.reservation`, `billing.invoice`, `documents.document`, `facility.service_ticket`, `internal.project`, and `internal.ticket`.

Entity types are owned by modules, versioned, and declared through manifests. The type key should remain semantically stable. Breaking changes should produce explicit migrations or new major versions rather than silently changing the meaning of existing entities.

## Relation types

A relation type defines the meaning and constraints of a relationship. A relation edge without a relation type is not acceptable because it does not explain why two entities are linked.

A relation type should define owner module, source entity types, target entity types, cardinality, inverse relation, temporal behavior, timeline visibility, graph visibility, search weight, permission implications, and whether it can be created by user, system, import, integration, or future agent.

Examples include lease contract for unit, reservation for unit, invoice generated from reservation, invoice generated from lease, document attached to entity, payment settles invoice, service ticket affects unit, cost allocated to property, and project has ticket.

## Entity edges

An entity edge is a concrete relationship between two entity refs under a relation type. Edges should be tenant-scoped, typed, auditable, and temporal-ready. V0 can start with valid-from/valid-to, recorded-at, recorded-by, source, status, and metadata fields without implementing full bitemporal history everywhere.

Edges are canonical in Postgres. Neo4j receives a projection.

## Neo4j projection

Neo4j should project entity registry rows as nodes and entity edges as relationships. It can denormalize display names, statuses, module ids, entity types, tenant ids, and selected domain properties useful for graph exploration. It should not store the full operational record for invoices, contracts, or reservations as the only truth.

If Neo4j is unavailable or stale, canonical ERP operations should continue. Graph views may degrade or show projection lag.

## V0 entity catalog

The first entity catalog should include Core entities, property entities, rental entities, billing entities, accounting workflow entities, document entities, facility entities, and internal dogfood entities.

Core: tenant, legal entity, org unit, principal, user, agent placeholder, module installation.

Property/rental: property, building, unit, contact, lease contract, reservation, guest/contact, service ticket.

Billing/accounting: invoice draft, invoice, payment, supplier invoice or cost record, accounting export batch.

Documents: document, with file versions as child rows initially.

Internal dogfood: client, project, ticket, invoice draft, document.
