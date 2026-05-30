# V0 scope and modules

V0 must deliver a useful ERP aligned with the committed customer scope while establishing the foundations needed for future productization. It should not deliver the entire long-term TERP vision.

## V0 Core capabilities

V0 Core should include tenant/legal-entity model, principal model, BetterAuth authentication integration, SpiceDB authorization adapter, policy layer, module registry, module activation, action registry, entity registry, relation registry, audit events, domain events, outbox, worker runtime, document metadata, basic search, basic reporting foundations, and module manifests.

These capabilities are not optional platform indulgence. They are required to safely deliver multi-company ERP modules with permissions, audit, documents, exports, and cross-module links.

## V0 business MicroVerticals

### `internal.delivery`

The first dogfood MicroVertical should cover clients, projects, tickets, documents, and invoice drafts. It is valuable because the internal operator can use it immediately and discover issues in entity linking, permissions, document attachment, action flow, and billing drafts before the customer depends on the same patterns.

### `property.registry`

This MicroVertical covers legal-entity property structures: properties, buildings, units, states, technical metadata, equipment/labels, and links to documents/service tickets/reporting.

### `property.long_term_rental`

This MicroVertical covers lease contracts, tenants/contacts, deposits, basic payment schedules, terms, attachments, reminders, and links to invoices/documents/units.

### `property.short_term_rental`

This MicroVertical covers units, reservations, guests/contacts, reservation state, check-in/check-out basics, cleaning tasks, cancellation/change basics, and invoice draft links.

### `billing.core`

This MicroVertical covers invoice drafts, issued invoices basic, numbering series, legal-entity billing identity, receivables status, payment state basics, and export-ready invoice evidence.

### `accounting.office` and `accounting.export`

These MicroVerticals cover accounting workflow and handoff, not statutory accounting. V0 should include client/company workspace, document inbox basics, supplier/cost record basics, checklist/status workflow, expense assignment to legal entity/property/unit/contract, basic approvals, and export/import structure for the selected accounting system or Excel-based handoff.

### `documents.center`

This MicroVertical or Core-adjacent system module covers document metadata, upload, categorization, entity links, permissions, expiration, versions as child rows initially, and audit.

### `facility.basic`

This MicroVertical covers service tickets, issue states, priority, responsible person/supplier, photo/document links, and unit/building/property links. It should be minimal in V0.

### `reporting.basic`

Basic reporting should cover active contracts, reservations, occupancy basics, receivables, costs, export status, and holding/legal-entity views. Advanced BI/report builder is later.

## V0 exclusions

V0 excludes user-facing AI assistant, document AI automation, autonomous agents, process autodiscovery, user-facing vibemodule, full manufacturing ERP, machine/PLC integration, predictive maintenance, full channel manager/Airbnb/Booking integration, external portals, and full accounting engine.

The architecture should be ready to integrate these later without implementing them now.

## Accounting boundary

TERP should not implement statutory accounting. It should provide operational evidence, billing records, cost records, document links, approval/checklist workflow, and export/integration to accounting software. This boundary is important because the customer context explicitly prefers integration with mature accounting software rather than building accounting correctness ourselves.

## Manufacturing and Pulsar boundary

Manufacturing in 2027 should be handled as TERP manufacturing operations plus integration with a specialist partner for machine prediction and predictive maintenance. TERP should own production orders, products, BOM, material reservation, service tickets, ISO evidence, documents, and audit. Pulsar-like specialist systems can own machine analytics and prediction outputs, which TERP receives as events or integration payloads.
