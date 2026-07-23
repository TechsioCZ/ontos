# V0 scope and modules

V0 must deliver a useful ERP aligned with the committed customer scope while establishing the foundations needed for future productization. It should not deliver the entire long-term OntOS vision.

## V0 Core capabilities

V0 Core should include tenant/legal-entity model, principal model, Principal Auth Bindings for BetterAuth users/API keys, SpiceDB authorization adapter, policy layer, tenant-level module state, action invocation recording, audit events, domain events, outbox, worker runtime/checkpoints, media assets and media links, basic search index entries, basic reporting foundations, and OntOS Module Manifest support.

These capabilities are not optional platform indulgence. They are required to safely deliver multi-company ERP modules with permissions, audit, documents, exports, and cross-module links.

## V0 Business Modules

### `organization.registry`

This Foundational Module models shared organizational business structure over managed legal entities: legal-entity groups, holding/portfolio/acquisition-batch views, and group membership. In V0 it is a group/view model, not a corporate ownership/control ledger.

### `property.registry`

Current working assumption: this is the first customer-domain business module to validate after the foundation skeleton. It likely covers legal-entity property structures: properties or property complexes, buildings, units/spaces, ownership/management relationships, unit/space state, basic technical metadata, equipment/labels, and links to documents/service tickets/reporting. It appears to be the dependency root for long-term rental, short-term rental, facility, billing, documents, search, and reporting.

Open boundary to validate: lease contracts, reservations, pricing, invoicing, payments, cleaning tasks, facility workflows, accounting costs, and reporting aggregates probably belong to later MicroVerticals and link back to property resources through ResourceRefs or module-owned link tables.

### `internal.delivery`

This early dogfood MicroVertical should cover clients, projects, tickets, media/documents, and invoices with `status = draft` after the customer-domain rails are proven by `property.registry`. It is valuable because the internal operator can discover issues in ResourceRef linking, permissions, media attachment, action flow, and billing before those patterns are repeated broadly.

### `property.long_term_rental`

This business module covers lease contracts, tenants/contacts, deposits, basic payment schedules, terms, attachments, reminders, and links to invoices/documents/units.

### `property.short_term_rental`

This business module covers units/spaces, reservations, guests/contacts, reservation state, check-in/check-out basics, cleaning tasks, cancellation/change basics, and invoice source links. It should support guests as external actors. First-class capacity allocation contracts are a future discovery topic unless a concrete customer workflow requires them.

### `billing.core`

This business module covers invoices with draft/issued lifecycle, invoice lines, line-level source allocations, numbering series, legal-entity billing identity, receivables status, payment state basics, and export-ready invoice evidence.

### `accounting.office` and `accounting.export`

These business modules cover accounting workflow and handoff, not statutory accounting. V0 should include client/company workspace, document inbox basics, supplier/cost record basics, checklist/status workflow, expense assignment to legal entity/property/unit/contract, basic approvals, and export/import structure for the selected accounting system or Excel-based handoff.

### `documents.center`

This business module may add document-specific classification and workflows on top of Core media assets/links: categorization, expiration, versions, document-specific permissions/policies, and audit.

### `facility.basic`

This MicroVertical covers service tickets, issue states, priority, responsible person/supplier, photo/document links, and unit/building/property links. It should be minimal in V0.

### `reporting.basic`

Basic reporting should cover active contracts, reservations, occupancy basics, receivables, costs, export status, and holding/legal-entity views. Advanced BI/report builder is later.

## V0 exclusions

V0 excludes user-facing AI assistant, document AI automation, autonomous agents, process autodiscovery, user-facing vibemodule, full manufacturing ERP, machine/PLC integration, predictive maintenance, full channel manager/Airbnb/Booking integration, external portals, and full accounting engine.

The architecture should be ready to integrate these later without implementing them now.

## Accounting boundary

OntOS should not implement statutory accounting. It should provide operational evidence, billing records, cost records, document links, approval/checklist workflow, and export/integration to accounting software. This boundary is important because the customer context explicitly prefers integration with mature accounting software rather than building accounting correctness ourselves.

## Manufacturing and Pulsar boundary

Manufacturing in 2027 should be handled as OntOS manufacturing operations plus integration with a specialist partner for machine prediction and predictive maintenance. OntOS should own production orders, products, BOM, material reservation, service tickets, ISO evidence, documents, and audit. Pulsar-like specialist systems can own machine analytics and prediction outputs, which OntOS receives as events or integration payloads.
