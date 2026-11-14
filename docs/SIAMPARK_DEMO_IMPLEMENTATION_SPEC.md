# Siampark ERP demo — implementation handoff specification

Status: READY FOR IMPLEMENTATION  
Source of decisions: Wayfinder Map and closed issues 2–20 in Koudy1996/DEMO-Siampark  
Target repository: Koudy1996/DEMO-Siampark only

## 1. Purpose

This document is the implementation handoff for a fast presentation ERP demo for Siampark.

This is not a production ERP. The governing rule is:

> Build 100% of what must be convincingly shown during the presentation, at roughly 60% of production complexity.

The simplest implementation that preserves the visible business meaning wins.

Implementation is complete when the ten scenarios in this document can be executed from a deterministic reset dataset and produce the specified visible outcomes. Production non-functional requirements, real external-provider correctness, statutory-accounting correctness and generalized extensibility are not acceptance criteria.

## 2. Non-negotiable OntOS boundaries

The demo must preserve the existing OntOS ownership model.

- Core and Shell remain business-neutral.
- Siampark s.r.o. is the managed Legal Entity.
- Internal users and assignees are Principals.
- External people and organizations are Parties.
- Commercial or contractual relationships use Counterparty with CUSTOMER and SUPPLIER roles.
- A renter or guest is never an OntOS Tenant.
- Customer, supplier, contact, employee, calendar event, dashboard, accounting posting and sync status are not new master entities.
- Persistent business state changes go through declared Actions.
- Cross-module references use public ResourceRefs or equivalent public contracts, never shared private tables.
- Business relationships never imply permissions.
- Statutory accounting remains outside OntOS.
- External systems remain external and communicate through explicit owner-local integration seams.
- Presentation compositions may aggregate public reads, but must not become duplicate systems of record.

Do not create:
- a monolithic Siampark ERP module;
- a second customer/contact identity model;
- a generic workflow engine;
- a generic integration hub;
- a new auth system;
- a parallel statutory accounting system.

## 3. Reuse from the current repository

### 3.1 Direct reuse

Use the existing Core/Shell capabilities for:
- authentication and Principal context;
- Tenant and Legal Entity context;
- module composition/state;
- Actions and governed state changes;
- permissions and governed reads;
- Shell navigation/routing;
- shared search/resource-detail infrastructure where useful.

Use Party Registry directly for:
- Party;
- Counterparty;
- CUSTOMER / SUPPLIER roles;
- contact points;
- Party relationships;
- ARES lookup;
- existing Contacts/search surfaces.

### 3.2 Conditional reuse

Existing Inventory, Catalog, Pricing, Payment Term and Commerce capabilities are not automatically part of this demo.

Use them only if their existing semantics exactly match a selected scenario. The ten selected scenarios do not require full stock, order or commerce flows, so no such module is required for the minimum demo.

### 3.3 Shared infrastructure

Provider-neutral e-mail delivery already exists and may be reused. Real inbox delivery is not required; a deterministic simulation is acceptable.

## 4. Application composition

The demo consists of Core/Shell + Party Registry + six thin Siampark business owners.

| Module ID | Business owner | Canonical facts |
|---|---|---|
| siampark.property | Property | Property, Unit, Asset |
| siampark.occupancy | Occupancy | Occupancy for long-term lease and short stay |
| siampark.agreements | Agreements/Documents | Contract, Document Record, signature integration state |
| siampark.work | Work | Task |
| siampark.billing-finance | Billing/Finance | Operational Invoice, Financial Plan Entry, accounting/payment observations |
| siampark.relationships | Relationships | Relationship Activity |

The following are presentation compositions, not data owners:
- Dashboard / Overview;
- Unified calendar / agenda;
- Management reporting;
- Integration status overview;
- Global search.

## 5. Canonical domain model

### 5.1 Existing OntOS Resources

#### Legal Entity
Reuse the existing Core Legal Entity for Siampark s.r.o.

No second Siampark company/customer record is created.

#### Principal
Reuse existing Principal semantics for the four demo personas and task ownership.

#### Party / Counterparty
Reuse Party Registry.

Required demo usage:
- PERSON and ORGANIZATION Parties;
- Counterparty CUSTOMER role;
- Counterparty SUPPLIER role;
- EMAIL / PHONE / ADDRESS contact points as useful;
- CONTACT_PERSON_OF where a contact person relation is needed.

All CRM, Contract, Occupancy, Invoice and Relationship Activity records reference Party/Counterparty instead of duplicating names and addresses as canonical identity.

### 5.2 Property

Owner: siampark.property

Minimum fields:
- id
- code
- name
- legalEntityRef
- address
- lifecycleState
- optional note
- createdAt / updatedAt

Lifecycle:
- PLANNED
- ACTIVE
- INACTIVE
- DISPOSED

Required Actions:
- create property
- update property
- change property lifecycle state

Required reads:
- property list
- property detail
- property summary for dashboard/reporting

### 5.3 Unit

Owner: siampark.property

Minimum fields:
- id
- propertyRef
- code
- name
- optional unitKind
- optional capacity
- lifecycleState
- optional note

Lifecycle:
- ACTIVE
- OUT_OF_SERVICE
- RETIRED

Availability is derived from Unit lifecycle + current Occupancy. Do not persist FREE / RESERVED / OCCUPIED as a second independent lifecycle.

Required Actions:
- create unit
- update unit
- change unit lifecycle state

Required reads:
- unit list filtered by Property/state/availability
- unit detail
- current derived availability
- occupancy/contract/task links through public reads

### 5.4 Asset

Owner: siampark.property

Represents individually managed equipment or fixed operational assets. It is not fungible warehouse stock.

Minimum fields:
- id
- propertyRef
- optional unitRef
- code
- name
- category
- optional serialNumber
- lifecycleState
- optional acquiredAt
- optional lastServiceAt
- optional nextServiceAt
- optional supplierCounterpartyRef

Lifecycle:
- PLANNED
- ACTIVE
- OUT_OF_SERVICE
- DISPOSED

Required Actions:
- create/update Asset
- change Asset lifecycle state

Required reads:
- asset list/detail
- tasks linked to Asset

### 5.5 Occupancy

Owner: siampark.occupancy

One entity covers both long-term leases and short stays.

Minimum fields:
- id
- kind: LONG_TERM_LEASE | SHORT_STAY
- unitRef
- customerCounterpartyRef or guestPartyRef
- startDate
- optional endDate
- state
- optional peopleCount for short stay
- optional contractRef
- optional externalBookingCorrelation
- optional note

Lifecycle:
- DRAFT
- CONFIRMED
- ACTIVE
- COMPLETED
- CANCELLED

Required Actions:
- create draft Occupancy
- confirm Occupancy
- activate Occupancy
- complete Occupancy
- cancel Occupancy
- simulate/import booking observation for short-stay scenario

Required validation:
- the selected Unit must be usable for the requested period;
- a conflicting active/confirmed Occupancy must be visibly rejected or flagged;
- no production-grade allocation engine is required.

Required reads:
- occupancy list with kind/state/date filters
- occupancy detail
- Unit occupancy/availability projection
- compact availability calendar

### 5.6 Contract

Owner: siampark.agreements

Minimum fields:
- id
- kind, at least LEASE and OTHER
- counterpartyRef
- optional propertyRef
- optional unitRef
- optional occupancyRef
- optional supersedesContractRef for the renewal scenario
- startDate
- optional endDate
- lifecycleState
- optional renewalNoticeDate
- optional value/amount only when useful in the scenario
- optional note

Lifecycle:
- DRAFT
- ACTIVE
- TERMINATED
- EXPIRED

Signature is a separate concern and must not be encoded into Contract lifecycle.

Minimum signature simulation state:
- NOT_SENT
- SENT
- SIGNED
- DECLINED

Required Actions:
- create/update Contract
- activate Contract
- terminate Contract
- create renewal/successor draft
- simulate send for signature
- simulate signature result

Required reads:
- contract list
- contract detail
- expiring-soon projection
- linked Documents and business references

### 5.7 Document Record

Owner: siampark.agreements

Minimum fields:
- id
- title
- kind
- lifecycleState
- optional contractRef
- optional contextRefs
- optional fileName
- optional media/file reference
- optional signedDocumentReference
- createdAt / updatedAt

Lifecycle:
- DRAFT
- FINAL
- ARCHIVED

Document binary storage is not required for the demo if the current media seam is not convenient. Metadata plus a credible attachment placeholder and signed reference are sufficient.

Required Actions:
- create/update Document Record
- finalize
- archive

### 5.8 Operational Invoice

Owner: siampark.billing-finance

This is an operational billing fact, not a statutory accounting posting.

Minimum fields:
- id
- direction: OUTGOING | INCOMING
- counterpartyRef
- optional propertyRef
- optional unitRef
- optional occupancyRef
- optional contractRef
- optional taskRef
- documentNumber
- issueDate
- dueDate
- currency
- totalAmount
- businessState
- paymentState
- accountingSyncState
- optional externalAccountingReference
- optional note

Minimum businessState:
- DRAFT
- CONFIRMED
- CANCELLED

Minimum paymentState:
- UNPAID
- PARTIALLY_PAID
- PAID

Minimum accountingSyncState:
- NOT_SENT
- PENDING
- SYNCED
- FAILED

OVERDUE is derived:
dueDate is before the current demo date and paymentState is not PAID.

Required Actions:
- create/update invoice draft
- confirm invoice
- cancel invoice
- request accounting sync
- retry failed accounting sync
- apply simulated external payment/accounting observation

Required reads:
- invoice list/detail
- due/overdue projection
- property finance summary
- dashboard finance summary

### 5.9 Financial Plan Entry

Owner: siampark.billing-finance

Use only for simple plan-vs-actual / property planning presentation.

Minimum fields:
- id
- propertyRef
- period
- kind: COST | REVENUE
- category
- plannedAmount
- currency
- lifecycleState

Lifecycle:
- PLANNED
- CONFIRMED
- CANCELLED

Actual values should be derived from Operational Invoices or seeded external summaries rather than duplicated into a second accounting ledger.

### 5.10 Task

Owner: siampark.work

One Task capability covers maintenance, incidents, contract follow-up and relationship follow-up.

Minimum fields:
- id
- title
- optional description
- state
- priority
- ownerPrincipalRef
- dueDate
- contextRefs
- createdAt / updatedAt

Lifecycle:
- NEW
- IN_PROGRESS
- WAITING
- DONE
- CANCELLED

Required Actions:
- create Task
- update Task
- assign/reassign
- change state

Required reads:
- task list/detail
- tasks by Principal
- tasks by linked Resource
- due/overdue projection

The calendar is a derived view and must not own duplicate Task dates.

### 5.11 Relationship Activity

Owner: siampark.relationships

Historical CRM-like interaction only. No sales pipeline.

Minimum fields:
- id
- partyRef or counterpartyRef
- kind: CALL | EMAIL | MEETING | NOTE
- occurredAt
- ownerPrincipalRef
- summary
- optional followUpTaskRef

No workflow state is required.

Required Actions:
- record Relationship Activity

Required reads:
- chronological activity list for Party/Counterparty
- activities assigned/visible to External Agent

## 6. Owner-local demo integration records

Do not create a generic integration master entity.

Each owning module may persist a minimal technical Integration Attempt / Observation record when needed by the scenario.

Minimum common fields:
- id
- ownerResourceRef
- integrationKind
- providerLabel
- externalCorrelationId
- status
- attemptedAt
- optional completedAt
- optional externalReference
- compact safe requestSummary
- compact safe resultSummary / fake receipt
- optional errorCode / errorMessage

Minimum presentation status:
- PENDING
- SUCCESS
- FAILED
- CONFLICT where meaningful

These records are implementation support for the demo integration surfaces, not a new cross-domain business owner.

## 7. External integration contracts

### 7.1 Accounting

Owner: siampark.billing-finance

Outbound meaning:
- confirmed Operational Invoice;
- direction;
- counterparty correlation;
- dates;
- currency and total;
- relevant Property/Contract/Occupancy references.

Inbound simulated meaning:
- external accounting document ID;
- accepted/posting status;
- payment status/observation;
- selected summary values used by management views.

Demo behavior:
- explicit external correlation;
- NOT_SENT → PENDING → SYNCED or FAILED;
- at least one seeded FAILED case;
- retry Action produces deterministic success and fake receipt/log.

Do not implement:
- ledger;
- chart of accounts;
- tax engine;
- FX;
- depreciation;
- statutory AR/AP;
- closing;
- bank reconciliation.

The UI must remain provider-neutral. Do not hardcode Evala or i6 as canonical authority.

### 7.2 Bank/payment

No direct bank connector is required.

Payment status arrives as a simulated/imported observation through the accounting seam.

### 7.3 Booking platform

Owner: siampark.occupancy

Inbound simulated meaning:
- external booking ID;
- external listing/unit correlation;
- dates;
- party/guest count;
- booking state.

Outbound simulated meaning:
- local availability/block period or Occupancy state necessary to demonstrate the seam.

Required demo states:
- one successful imported A-103 booking;
- one conflict/failed observation;
- deterministic retry/reconciliation.

### 7.4 Electronic signature

Owner: siampark.agreements

Outbound simulated meaning:
- Contract/Document reference;
- signer identity/contact;
- signature request.

Inbound simulated meaning:
- provider reference;
- SENT / SIGNED / DECLINED;
- signed document reference.

No real signature provider is required.

### 7.5 E-mail

Reuse provider-neutral e-mail delivery if convenient.

Business owner decides message meaning. Real inbox delivery is not required.

The demo only needs a visible successful submission/notification observation.

### 7.6 ARES

Reuse Party Registry's existing ARES seam. Do not build a second company-registry integration.

### 7.7 Payroll

Placeholder only. No payroll data or calculations.

### 7.8 Physical security

No connector. Security devices may be represented as Asset/evidence metadata only if useful.

## 8. Personas and authorization

Seed four Principals:
1. Management
2. Operations Manager
3. Finance / Accounting Liaison
4. External Agent / Sales Collaborator

Primary presenter: Operations Manager.

Only two contexts must be visibly demonstrated:
- Operations Manager: broad demo access.
- External Agent: restricted access.

External Agent may see:
- assigned/allowed Parties/Counterparties;
- assigned Relationship Activities;
- assigned Tasks.

External Agent must not see:
- portfolio-wide Property data;
- Finance;
- Integrations;
- unrelated Counterparties or Tasks.

Implementation requirement:
- coarse module-area permissions;
- at least one visible resource-level restriction or denial.

Do not implement:
- RBAC editor;
- approval hierarchy;
- field-level permission builder.

CUSTOMER/SUPPLIER roles and Party Relationships never grant permissions.

## 9. Shell navigation and screens

### 9.1 Přehled

Dashboard cards:
- occupied / available Units;
- contracts expiring soon;
- open / overdue invoices;
- open maintenance/tasks;
- integration warnings.

Include one compact attention feed linking to owner detail pages.

No dashboard-owned data.

### 9.2 Nemovitosti a majetek

Required:
- Property list;
- Property detail;
- Unit detail;
- Asset detail for maintenance scenario;
- minimal create/edit forms needed by demo.

Property detail sections:
- summary;
- Units;
- Assets;
- active Occupancies;
- Contracts/Documents;
- Tasks;
- finance summary.

### 9.3 Pobyty a pronájmy

Required:
- Occupancy list with LONG_TERM_LEASE / SHORT_STAY filters;
- Occupancy detail;
- create/edit form for golden path;
- compact Unit availability calendar;
- booking sync/conflict indicator.

### 9.4 Kontakty a vztahy

Reuse Party Registry Contacts/search.

Add:
- relationship activity timeline/section;
- next follow-up Task link.

Do not create:
- separate customer master;
- separate supplier master;
- CRM pipeline.

### 9.5 Smlouvy a dokumenty

Required:
- Contract list;
- Contract detail;
- create/edit Contract;
- Document metadata section;
- signature simulation state/timeline;
- expiring/renewal attention.

### 9.6 Finance

Required:
- invoice list;
- invoice detail;
- minimal invoice create/edit;
- payment state;
- accounting sync panel;
- property income/cost summary;
- open/overdue summary;
- simple plan-vs-actual cards if useful.

No statutory accounting screens.

### 9.7 Úkoly a kalendář

Required:
- Task list/detail;
- Task edit/state change;
- derived read-only calendar/agenda from Tasks, Contracts and Occupancies.

Editing a calendar item routes to its owning record.

### 9.8 Integrace

Presentation-only overview.

Rows/cards:
- Accounting
- Booking
- Signature
- E-mail
- Payroll placeholder

Show:
- provider-neutral label;
- last attempt;
- external correlation;
- status;
- compact fake receipt/log;
- retry Action where the scenario needs it.

ARES remains in Party Registry context.

## 10. Minimum reporting surfaces

Required only:
- portfolio occupancy / available units;
- contracts expiring soon;
- open / overdue invoices and payment state;
- property-level income/cost summary;
- open maintenance/tasks;
- integration health/errors.

Use cards, tables and at most simple charts.

Do not implement arbitrary report builders or statutory reports.

## 11. Deterministic demo dataset

All data is synthetic.

Use stable fixture keys. Implementations may map them to deterministic UUIDs.

### 11.1 Tenant / Legal Entity

- tenant.siampark-demo
- legal-entity.siampark

### 11.2 Principals

- principal.management
- principal.operations
- principal.finance
- principal.external-agent

### 11.3 Properties and Units

Property A:
- property.parkova — Rezidence Parková
- unit.parkova.a101 — AVAILABLE at baseline
- unit.parkova.a102 — occupied long-term
- unit.parkova.a103 — short-stay / booking scenario
- asset.parkova.hvac01 — active asset with maintenance task

Property B:
- property.riverside — Apartmány Riverside
- unit.riverside.b201 — occupied, contract expiring soon
- unit.riverside.b202 — available

No deeper building/floor/room hierarchy is required.

### 11.4 Parties / Counterparties

Seed approximately 6–8 Party Registry subjects:

CUSTOMER:
- customer.a102-tenant
- customer.b201-tenant
- customer.golden-a101

Guest:
- guest.a103-shortstay

SUPPLIER:
- supplier.maintenance
- supplier.utilities

Optional:
- counterparty.external-agent-assigned

Use Party Registry IDs as canonical identity. Fixture aliases above are seed references only.

### 11.5 Baseline Occupancies

- unit.parkova.a101: no active Occupancy
- unit.parkova.a102: ACTIVE LONG_TERM_LEASE
- unit.parkova.a103: SHORT_STAY imported from simulated booking platform
- unit.riverside.b201: ACTIVE LONG_TERM_LEASE
- unit.riverside.b202: no active Occupancy

Also seed one booking sync conflict for A-103.

### 11.6 Baseline Contracts

- contract.a102.lease — ACTIVE
- contract.b201.lease — ACTIVE and expiring soon
- related Document Records
- one historical SIGNED signature observation

No A-101 Contract exists at baseline.

### 11.7 Baseline invoices

Customer:
- invoice.a102.paid — PAID
- invoice.b201.overdue — UNPAID and derived OVERDUE

Supplier:
- invoice.parkova.supplier — open/synced-or-pending property cost
- invoice.riverside.supplier — property cost for drill-down

No A-101 lease invoice exists at baseline.

### 11.8 Tasks

Seed approximately four:
- task.hvac-maintenance
- task.b201-renewal
- task.operations-followup
- task.external-agent-assigned

### 11.9 Relationship Activities

Seed 2–3:
- completed interaction
- next follow-up context
- External-Agent-visible assigned activity

### 11.10 Integration observations

Accounting:
- one SUCCESS observation
- one FAILED observation tied to invoice.b201.overdue

Booking:
- one SUCCESS imported A-103 booking
- one CONFLICT/FAILED observation

Signature:
- one historical SIGNED observation
- A-101 is created live during golden path

E-mail:
- one successful notification observation

Payroll:
- placeholder only

### 11.11 Reset contract

Provide one deterministic reset command/seed path that restores:
- A-101 available;
- no A-101 Contract;
- no A-101 Occupancy;
- no A-101 lease invoice;
- the baseline warning/error states above.

The exact command name is implementation-defined, but reset must be one-step and documented.

## 12. Presentation scenarios

### Scenario 1 — Golden path: new long-term lease

Persona: Operations Manager

Start:
- A-101 available
- customer.golden-a101 exists
- no A-101 Contract/Occupancy/invoice

Flow:
1. Open Dashboard.
2. Open Rezidence Parková → A-101.
3. Open/select the existing CUSTOMER Counterparty.
4. Create LONG_TERM_LEASE Occupancy in DRAFT.
5. Confirm Occupancy.
6. Create linked lease Contract in DRAFT.
7. Simulate signature: NOT_SENT → SENT → SIGNED.
8. Activate Contract.
9. Activate Occupancy.
10. Create first outgoing Operational Invoice.
11. Confirm Invoice.
12. Trigger simulated accounting sync.
13. Return to Property detail / Dashboard.

Expected visible result:
- A-101 becomes derived OCCUPIED;
- active Occupancy visible;
- active Contract and signed Document metadata visible;
- new invoice visible;
- accounting sync visible;
- occupancy/dashboard figures change predictably.

Simulation:
- e-signature
- accounting

### Scenario 2 — Short-stay booking import

Persona: Operations Manager

Start:
- A-103 has imported booking fixture.

Flow:
- open Pobyty a pronájmy;
- filter SHORT_STAY;
- open A-103 Occupancy;
- show external booking correlation and sync state.

Expected:
- booking appears as a normal Occupancy owned by Siampark;
- provider correlation is visible without creating a second booking master.

Simulation:
- booking platform.

### Scenario 3 — Asset maintenance

Persona: Operations Manager

Start:
- asset.parkova.hvac01 ACTIVE;
- task.hvac-maintenance NEW.

Flow:
- Property → Asset → linked Task;
- move Task NEW → IN_PROGRESS → DONE.

Expected:
- maintenance status changes;
- Asset remains the canonical equipment record;
- Task timeline/update is visible.

Simulation:
- none required.

### Scenario 4 — Contract renewal

Persona: Operations Manager

Start:
- contract.b201.lease expiring soon.

Flow:
- Dashboard warning → Contract detail;
- create successor/renewal DRAFT linked by supersedesContractRef;
- optionally create/close renewal Task.

Expected:
- expiry attention is resolved/changed;
- old and new contract relationship is clear.

Simulation:
- signature may remain optional or simulated.

### Scenario 5 — Supplier invoice and property cost

Persona: Finance Liaison or Operations Manager

Start:
- supplier invoice linked to Property A/B.

Flow:
- Finance → supplier invoice → Property detail/finance summary.

Expected:
- supplier is Party/Counterparty;
- invoice contributes to property cost summary;
- no statutory posting UI appears.

Simulation:
- accounting status may be simulated.

### Scenario 6 — Overdue invoice and payment observation

Persona: Finance Liaison / Operations Manager

Start:
- invoice.b201.overdue UNPAID, due date in past.

Flow:
- Dashboard overdue card → Invoice detail;
- apply simulated external payment observation;
- paymentState becomes PAID.

Expected:
- OVERDUE derived condition disappears;
- dashboard overdue count updates;
- external payment/accounting observation is visible.

Simulation:
- accounting/payment.

### Scenario 7 — Relationship follow-up

Persona: Operations Manager

Start:
- existing Counterparty with Relationship Activity.

Flow:
- Contacts/Relationships → Counterparty detail;
- add Activity;
- create or link follow-up Task.

Expected:
- chronology updates;
- follow-up is represented by Work Task, not a second CRM workflow.

Simulation:
- optional e-mail submission only.

### Scenario 8 — Management drill-down

Persona: Management

Flow:
- Dashboard → Property portfolio;
- inspect occupancy, expiring contract, overdue/open invoice, costs and tasks.

Expected:
- every number links back to an owning record;
- no duplicated reporting master data.

Simulation:
- selected accounting summary values may be seeded/simulated.

### Scenario 9 — Restricted External Agent

Persona: External Agent

Start:
- one assigned Counterparty/Activity/Task.

Flow:
- sign in/switch to External Agent;
- show permitted Contacts/Relationships/Tasks;
- confirm Finance/Integrations/portfolio views are hidden or denied;
- demonstrate one resource-level denial/filter.

Expected:
- permission boundary is obvious without an RBAC editor.

Simulation:
- none.

### Scenario 10 — Integration failure and retry

Persona: Operations Manager or Finance Liaison

Start:
- FAILED accounting sync on invoice.b201.overdue or booking conflict on A-103.

Flow:
- Integrations → failed item;
- inspect external correlation and fake receipt/log;
- execute Retry;
- deterministic PENDING → SUCCESS.

Expected:
- integration health card clears/changes;
- owning business record remains canonical.

Simulation:
- external provider response.

## 13. Fidelity classification

### DEMO MUST HAVE

Real interactive behavior:
- Core/Shell authentication and context;
- Party Registry reuse;
- Property/Unit/Asset;
- Occupancy;
- Contract/Document metadata;
- Task;
- Operational Invoice / minimal Financial Plan Entry;
- Relationship Activity;
- Dashboard/reporting/calendar compositions;
- integration status overview;
- coarse authorization + one resource restriction;
- all state changes used by the ten scenarios.

### DEMO SIMULATION

- accounting sync/posting/payment observations;
- bank/payment behind accounting;
- booking import/sync/conflict;
- e-signature;
- e-mail delivery;
- integration retry/fake receipt/log;
- management values sourced from external/statutory accounting.

### PLACEHOLDER

- payroll connector;
- vendor-specific accounting configuration;
- production signature-provider configuration;
- production booking-provider configuration/credentials;
- deep statutory-accounting handoff screens;
- optional future warehouse/inventory entry;
- physical-security integration.

### OUT OF SCOPE

- full warehouse/material planning;
- Commerce Inventory reservation for room/lease booking;
- quotation/order/delivery chain;
- CRM sales pipeline;
- project portfolio / advanced capacity planning;
- automated meter ingestion;
- advanced energy calculations;
- internal chat;
- statutory ledger/journals;
- tax/FX/depreciation engine;
- bank reconciliation;
- payroll calculation;
- real accounting/bank/booking/payroll/signature integrations;
- generalized workflow engine;
- generic connector hub;
- production-grade RBAC;
- HA/scaling;
- complete production audit sophistication;
- production data migration;
- arbitrary BI/report builder.

## 14. Traceability matrix

| Capability | Owner | Primary screen | Scenario | Fidelity | Fixture |
|---|---|---|---|---|---|
| Party / Counterparty | Party Registry | Kontakty a vztahy | 1, 5, 7, 9 | MUST HAVE | customer.*, supplier.* |
| Property / Unit | siampark.property | Nemovitosti a majetek | 1, 8 | MUST HAVE | property.*, unit.* |
| Asset | siampark.property | Nemovitosti a majetek | 3 | MUST HAVE | asset.parkova.hvac01 |
| Occupancy | siampark.occupancy | Pobyty a pronájmy | 1, 2 | MUST HAVE | A-102/A-103/B-201 + live A-101 |
| Contract | siampark.agreements | Smlouvy a dokumenty | 1, 4 | MUST HAVE | contract.a102.lease, contract.b201.lease |
| Signature | siampark.agreements | Contract detail | 1, 4 | SIMULATION | historical signed + live A-101 |
| Task | siampark.work | Úkoly a kalendář | 3, 4, 7, 9 | MUST HAVE | task.* |
| Invoice | siampark.billing-finance | Finance | 1, 5, 6 | MUST HAVE | invoice.* |
| Payment/accounting | siampark.billing-finance | Invoice detail / Integrace | 1, 6, 10 | SIMULATION | accounting observations |
| Relationship Activity | siampark.relationships | Kontakty a vztahy | 7, 9 | MUST HAVE | activity fixtures |
| Dashboard/reporting | composition | Přehled | 1, 8 | MUST HAVE | derived from all above |
| Calendar | composition | Úkoly a kalendář | 3, 4, 7 | MUST HAVE | derived dates |
| Booking integration | siampark.occupancy | Occupancy / Integrace | 2, 10 | SIMULATION | A-103 observations |
| Payroll | external placeholder | Integrace | none | PLACEHOLDER | none |

## 15. Acceptance criteria

The demo is accepted when:

1. The reset restores the deterministic baseline in one documented step.
2. All ten scenarios can be executed without editing the database manually.
3. The golden path starts with A-101 available and ends with:
   - active long-term Occupancy;
   - active linked Contract;
   - visible signed-document state/reference;
   - first outgoing Invoice;
   - visible accounting sync;
   - changed dashboard/property summary.
4. Party/Counterparty identity is reused everywhere; no parallel customer/supplier master exists.
5. Unit availability, overdue invoice and expiring-contract indicators are derived consistently.
6. External Agent cannot see Finance/Integrations/portfolio-wide data and at least one resource-level restriction is visibly enforced.
7. Integration simulations expose correlation, status, compact fake evidence and deterministic retry where specified.
8. Reporting numbers link back to owning records.
9. No selected scenario depends on a real external provider.
10. No out-of-scope capability is required to complete the presentation.

## 16. Implementation guardrails

- Prefer seeded read-only data unless a scenario explicitly needs an edit.
- Implement only Actions used by a scenario; other states may be seeded.
- Keep state machines small.
- Avoid generic frameworks created only for hypothetical future reuse.
- Do not turn Dashboard/Calendar/Reporting/Integrations into new systems of record.
- Keep vendor names/configuration neutral.
- Never use Inventory Reservation as accommodation booking.
- Do not create separate Person/Customer/Supplier tables outside Party Registry.
- Do not model statutory accounting internally.
- Keep the demo resettable and deterministic.

## 17. Recommended implementation order

This is sequencing guidance, not new scope.

1. Verify baseline Shell/Core/Party Registry boot and demo personas.
2. Implement siampark.property with seeded Properties/Units/Asset.
3. Implement siampark.occupancy and derived Unit availability.
4. Implement siampark.agreements with Contract/Document and signature simulation.
5. Implement siampark.billing-finance with invoices and accounting/payment simulation.
6. Implement siampark.work and siampark.relationships.
7. Build Dashboard, calendar, reporting and integrations compositions.
8. Seed/reset the complete dataset.
9. Wire authorization for Operations Manager vs External Agent.
10. Validate scenarios 1–10 in order and remove any implementation that is not needed by them.

## 18. Discovery closure

No additional business discovery is required for the presentation-only Destination.

If the goal changes toward production ERP or formal customer acceptance, reopen discovery for:
- real process owners;
- real accounting product and mappings;
- production KPI definitions;
- real customer data;
- provider contracts/credentials;
- statutory accounting requirements;
- production RBAC;
- migration;
- non-functional requirements.

Until that Destination changes, this specification is the implementation authority for the Siampark presentation demo.
