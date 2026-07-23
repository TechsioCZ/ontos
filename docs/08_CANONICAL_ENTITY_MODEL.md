# Canonical resource reference model

OntOS needs strong domain modeling and cross-module addressability without forcing every business object into a central Core entity graph. The chosen model is explicit Postgres domain tables owned by modules, plus value-based `ResourceRef` references where Core or another module needs to point at a business object.

## Why not generic JSON/EAV

A generic `entities` table with arbitrary JSON payloads would make early prototyping look flexible, but it would damage ERP correctness. Billing, rental contracts, reservations, payments, accounting exports, reporting, constraints, indexes, migrations, and auditing need explicit structures.

V0 core ERP data should not be built on generic JSON as the primary model. Generated or configurable modules may later use metadata-backed storage, but that is not the default canonical model for committed ERP workflows.

## Why not a central Core entity registry

A central Core entity registry would make Core responsible for business topology: which entities exist, how they evolve, how they are linked, and which relationships matter. That is too rigid for the product direction. Modules need to evolve their own domain models over time without forcing Core to become the ontology owner.

Direct foreign keys between every possible module pair would also be too tight. Billing may need to reference reservations, lease contracts, service tickets, properties, documents, parties, or imported external records. Hard foreign keys for every future relationship would create an expanding dependency web.

The compromise is `ResourceRef`: a stable value reference shaped as `tenant_id + module_key + resource_type + resource_id`. It gives Core, audit, media links, search entries, events, outbox payloads, and cross-module tables a common way to point at a resource without owning that resource.

## ResourceRef

A `ResourceRef` is not a row in a central registry. It is a value stored by the caller when a resource must be referenced across a boundary.

Canonical shape:

- `tenant_id`
- `module_key`
- `resource_type`
- `resource_id`

Optional contextual columns may sit beside it when the table needs query scoping, such as `legal_entity_id`, `created_at`, `source_module_key`, or denormalized display fields.

## Module ownership

The owning module keeps the canonical table, constraints, migrations, lifecycle, status semantics, and business rules for its resources.

Examples:

- `property.registry` owns properties, buildings, and units/spaces.
- `billing.core` owns invoices, invoice lines, numbering series, and invoice line source allocations.
- `organization.registry` owns legal-entity groups and group membership views.
- Core owns tenants, managed legal entities, principals, auth bindings, module state, actions, audit, events, outbox, media assets, media links, search index entries, and worker checkpoints.

## Full resource vs child row

A full resource has independent business identity over time. It may be addressable, searchable, linkable, auditable, visible in timelines, or referenced by other modules. Examples include property, building, unit/space, lease contract, reservation, invoice, payment, media asset, service ticket, accounting export batch, party, project, and ticket.

A child row or value object exists inside a parent and should not be independently addressable by default. Examples include invoice lines, tax breakdown rows, price breakdown rows, payment schedule items, contact methods, checklist items, and export lines.

A child row can later become addressable if it develops its own lifecycle, permissions, document links, workflow, reporting, or external identity. That decision belongs to the owning module, not Core.

## Cross-module links

Cross-module links should be stored as `ResourceRef` values, not physical foreign keys. The owning module can expose resolvers, read models, APIs, or UI components for display and validation.

For example, `BILLING_INVOICE_LINE_SOURCES` can point to a `property.registry` unit, building, reservation, lease, service, manual entry, or import row by storing source module/resource fields. Billing does not need a physical FK to every possible source table.

## Organization Registry

`organization.registry` is a Foundational Module, not Core. It models shared organizational business structure such as legal-entity groups, holdings, portfolios, acquisition batches, and similar views over managed legal entities.

In V0 it is a group/view model. It is not a full ownership/control ledger. If legal ownership percentages, control rights, shareholders, or bitemporal corporate history become real product requirements, they should be added in Organization Registry as domain tables, not in Core.

## Graph projection

Neo4j, if introduced, should be a replayable projection built from module-owned canonical tables, domain events, and selected `ResourceRef` links. It should not be the source of truth for operational ERP decisions.

If Neo4j is unavailable or stale, canonical ERP operations should continue. Graph views may degrade or show projection lag.

## Search and media projections

Search index entries and media links may store `ResourceRef` values to point at module-owned resources. They are projections or cross-cutting attachment records, not proof that Core owns the business resource.

Search authorization should use SpiceDB list-filtering patterns and scoped candidate checks rather than a separate Core visibility/access-class model.
