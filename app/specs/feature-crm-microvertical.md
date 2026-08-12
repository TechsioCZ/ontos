---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM MicroVertical

## Feature Description

Add the first independently deployable CRM MicroVertical to OntOS. The deployment app ID is `crm`
and its OntOS business module ID is `crm.core`. It owns five CRM entities: Customer, Contact, Deal,
Offer, and Activity.

CRM users can maintain a tenant-wide directory of customer companies and their contacts, record
relationship history, and manage legal-entity-owned Deals and Offer revisions. Every mutation is
performed by one dedicated typed Action. Ordinary edits cannot change lifecycle status,
primary-contact designation, or deletion state.

The first version intentionally excludes search, product catalogs, configurable pipelines, tags,
file attachments, document rendering, email sending, telephone integration, meeting scheduling,
and per-record CRM sharing rules.

## User Story

As a user responsible for customer relationships and sales
I want to manage customer companies, their contacts, interactions, Deals, and Offers in OntOS
So that the current relationship and commercial history are traceable, attributable, and audited

## Problem Statement

OntOS has Shell/Core infrastructure for module discovery, governed reads, typed Actions, audit,
resource detail, timelines, tenant/legal-entity isolation, and independently deployable
MicroVerticals, but it has no production business MicroVertical and no CRM-owned business data.
Customer and contact ownership is explicitly unresolved in the repository-level product context.

The requested CRM must not be implemented as generic Party records. In this bounded context a
Customer is always a company, and a Contact is a person belonging to exactly one Customer. A
Customer is shared once per tenant, while Deals, Offers, and Activities belong to the selected
Legal Entity.

The current Action scaffold emits a fail-closed placeholder handler and does not provide the
complete callable per-Action BFF contract/client boundary needed by the CRM UI. The approved
Codesmith boundary is narrower: generate the Action contract plus deterministic transport and
registration wiring, but never generate the private business handler. Owner-local schemas,
repositories, services, and Effect handlers are authored as CRM implementation code; migrations
are generated from the typed Drizzle schema. Shell resource-detail/timeline contributions still
require an approved generated entrypoint before their business implementations are added.

## Solution Statement

Generate a new UltraModern.js MicroVertical named `crm`, then generate its `crm.core` module
contract before any business artifact. Give the vertical its own PostgreSQL `crm` schema, migration
history, typed Drizzle schema, Effect repositories/services, strict Effect BFF contracts and
generated clients, and owner-local runtime registration.

Use the following domain model:

| Entity   | Ownership             | Relationship and purpose                                                                           |
| -------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| Customer | Tenant-wide           | A company shared across the tenant's Legal Entities; parent of Contacts and Deals.                 |
| Contact  | Tenant-wide           | A person belonging to exactly one Customer.                                                        |
| Deal     | Legal Entity          | A potential sale to one Customer; optionally names one of that Customer's Contacts.                |
| Offer    | Deal/Legal Entity     | A numbered commercial revision belonging to one Deal.                                              |
| Activity | Customer/Legal Entity | A historical Note, Call, Email, Meeting, or Other entry; may also reference a Contact and/or Deal. |

Declare Customer, Contact, and Deal as public `crm.core` resource types. Treat Offer and Activity
as addressable CRM entities but child records rather than cross-module public ResourceRefs in this
version. Compose the Customer timeline from explicit Activity records plus meaningful Deal and
Offer lifecycle Domain Events; ordinary field edits remain available through audit and do not
clutter the relationship timeline.

All CRM operations require a selected, authorized Legal Entity because the current Shell and
SpiceDB module-access boundary is legal-entity based. Customer and Contact tables remain tenant-only
and therefore expose the same record from every authorized Legal Entity context. Deal, Offer, and
Activity tables use legal-entity RLS and never accept `tenantId` or `legalEntityId` from browser
payloads.

For v1, CRM module access grants visibility to all shared Customers and Contacts and to all Deals,
Offers, and Activities owned by the selected Legal Entity. Preserve an explicit path to later
per-resource SpiceDB restriction without changing CRM IDs or ResourceRefs.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits changes to `app/` and requires generator-first Actions and pages.
- `AGENTS.md` — authoritative MicroVertical, Action, Effect, database, module-entrypoint, and generator rules.
- `CONTEXT.md` — CRM vocabulary agreed during planning; keep it free of implementation detail.
- `README.md` — documents the pinned UltraModern vertical creation flow and repository toolchain.
- `package.json` — owns root generator commands and database/validation orchestration.
- `pnpm-workspace.yaml` — includes `verticals/*` and pins the framework/Effect cohort.
- `docs/architecture/MICROVERTICALS.md` — requires the independent deployment seam and generated Effect BFF client.
- `docs/architecture/ACTIONS.md` — defines the mandatory Action lifecycle, idempotency, audit, evidence, event, and transaction rules.
- `docs/architecture/ERRORS.md` — defines typed Effect errors and RFC 9457 BFF mappings.
- `docs/architecture/DATABASE.md` — requires the owner-local PostgreSQL schema, typed Drizzle access, and distinct migration journal.
- `docs/architecture/DATA_ACCESS.md` — defines legal-entity operation scope, Core-owned transactions, scoped services, and RLS.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — governs pages, APIs, resource detail, and timeline loading.
- `docs/architecture/MODULE_MANIFESTS.md` — defines the `appId`/`moduleId` split and generator order.
- `docs/architecture/ULTRAMODERN.md` — blocks unsupported hand-authored business artifact types.
- `docs/frontend/FRONTEND.md` — governs Effect client integration, UI states, i18n, accessibility, and presentation boundaries.
- `packages/core-runtime/src/permissions/context-access.ts` — current module/resource SpiceDB access adapter; extend only if the approved unrestricted-to-restricted resource path requires it.
- `packages/core-runtime/spicedb/bootstrap.yaml` — current module, resource, and Action permission model and its tests.
- `packages/core-runtime/src/reads/definition.ts` — governed read authorization contract.
- `packages/core-runtime/src/reads/runtime.ts` — fail-closed read lifecycle and result permission filtering.
- `apps/shell-super-app/api/modules/shell-resources.ts` — resource-detail and timeline provider orchestration.
- `scripts/scaffolding/action/scaffold.mts` — existing Action generator and potential composition point for approved Action transport scaffolding.
- `scripts/scaffolding/governed-contribution/scaffold.mts` — existing module API generation patterns.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable fixture coverage for any prerequisite generator extension.
- `scripts/verify-application-db-schema.mts` — add CRM-owned database verification without weakening exact Core/Auth inventories.
- `topology/reference-topology.json` — generated deployment topology after adding `crm`.
- `topology/ownership.json` — generated owner metadata after adding `crm`.
- `topology/local-overlays/development.json` — local CRM URLs, ports, API, and module-contract allowlist.

### New Files

- `verticals/crm/**` — generated UltraModern.js MicroVertical deployment; exact framework-owned files come from the pinned vertical generator.
- `verticals/crm/vertical.manifest.ts` — generated `crm.core` public OntOS Module Manifest, then populated with CRM Actions and public resources.
- `verticals/crm/vertical.registration.ts` — generated private owner-local registration for CRM implementations.
- `verticals/crm/src/actions/*.action.ts` — generated CRM Action descriptors and deterministic transport/registration wiring listed in the Action matrix below.
- `verticals/crm/src/actions/*.handler.ts` — manually authored private Effect business handlers bound owner-locally to generated Action descriptors.
- `verticals/crm/shared/apis/*.ts` — generated strict Effect API contracts for CRM reads and approved Action transports.
- `verticals/crm/api/*.ts` — generated server adapters that verify the Shell assertion and invoke governed reads or Actions.
- `verticals/crm/src/api/*.ts` — generated Effect BFF clients used by CRM feature integration.
- `verticals/crm/src/routes/[lang]/customers/**` — generated Customer page, then adapted into the Customer/Contact/timeline workspace.
- `verticals/crm/src/routes/[lang]/deals/**` — generated Deal page, then adapted into the Deal/Offer workspace.
- `verticals/crm/src/db/**` — manually authored owner-local typed Drizzle schema, connection/service integration, repositories/services, and CRM RLS definitions.
- `verticals/crm/drizzle/**` — generated CRM migration output with a CRM-specific Drizzle journal.
- `verticals/crm/tests/**` — CRM unit, integration, contract, component, and route tests.
- `scripts/scaffolding/resource-provider/scaffold.mts` — proposed generator for governed resource-detail/timeline starting points; create only after Task 1 approval.

## Implementation Plan

### Phase 1: Foundation

Correct the Action generator boundary, generate the `crm` deployment and its `crm.core` contract,
and establish the Shell-user Action identity boundary. Add owner-local database wiring and the
exact CRM schema without importing Core/Auth database executors or another module's source.

The Action scaffold generates typed descriptors, Action-specific Effect BFF transport, clients,
and registration wiring, but no handler. CRM schemas, repositories, services, and private Effect
handlers are manually authored owner-local implementation. Add tested Codesmith support for the
resource-detail/timeline entrypoints required by the approved CRM resources.

### Phase 2: Core Implementation

Implement all five entities, their invariants, dedicated Actions, owner-local services, generated
BFF contracts, and governed reads. Generate every Action before adapting it. Use optimistic version
checks for edits, deletions, primary-contact changes, and status transitions so concurrent updates
return typed `409` conflicts rather than overwrite data.

Implement soft deletion with `deletedAt` tombstones. Delete Actions affect only their target row;
they do not cascade or physically remove history. Deleted parents make their active descendants
unavailable for new mutations, while historical reads retain safe labels and references. Restore
Actions are out of scope.

### Phase 3: Integration

Generate Customer and Deal pages and the approved resource/timeline providers. Integrate the pages
only through generated Effect clients. Use existing `@techsio/ui-kit` components: semantic Table
parts for lists, FormInput and
FormTextarea for text fields, FormNumericInput for monetary values, Select for fixed enums, Badge
for compact statuses, StatusText for inline states, Dialog plus danger Button for deletion
confirmation, and Toast for transient Action results. Do not add a shared UI-kit component or CRM
visual token override unless implementation proves an API/token gap and the developer approves it.

Expose Czech and English CRM translations from the vertical. Represent loading, empty, validation,
forbidden, not-found, conflict, unavailable/retry, and success states explicitly. Keep CRM pages
private and non-indexable.

## Step by Step Tasks

The approved executable breakdown is the 21-ticket dependency graph in
[`../tickets.md`](../tickets.md). The checklist below records full-system requirements and is not a
single implementation task; use the ticket backlog for ownership, granularity, and execution order.

### 1. Establish the approved generator boundary

- [ ] Add disposable fixture tests under `scripts/scaffolding/tests/` proving that generated Actions contain typed contracts, Action-specific transport, clients, and registration wiring but no private handler or `NotImplemented` implementation.
- [ ] Refactor the Action scaffold to the approved boundary while preserving safe mutation, stable reruns, owner slots, traversal/cross-owner rejection, no partial writes, formatting, and generated TypeScript compilation.
- [ ] Add the approved generated entrypoint for Shell resource-detail/timeline providers before implementing those business providers.
- [ ] Record the narrow owner-local rule that CRM schemas, repositories, services, and private Effect handlers are manually authored, while Drizzle generates migrations.

### 2. Generate the CRM deployment and OntOS module contract

- [ ] From `app/`, run `mise exec -- pnpm dlx @bleedingdev/modern-js-create@3.5.0-ultramodern.96 crm --vertical` and review only the generated `verticals/crm`, topology, ownership, Shell remote, lockfile, and workspace changes.
- [ ] Immediately run `mise exec -- pnpm scaffold:module-contract -- --vertical crm --module crm.core` before any CRM business generator.
- [ ] Set the owner-authored manifest identity to display name `CRM`, kind `business_module`, and a history-preserving tenant lifecycle; keep topology `appId = crm` distinct from `moduleId = crm.core`.
- [ ] Add generator/contract tests proving the new deployment is allowlisted, independently buildable, discoverable by immutable module contract, and not statically imported by Shell/Core.

### 3. Generate the CRM identity boundary and persistence foundation

- [ ] Run `mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical crm` exactly once before exposing any Action BFF endpoint.
- [ ] Author the CRM schema, repositories, services, configuration, and verification files owner-locally; generate migrations from the typed Drizzle schema.
- [ ] Give CRM PostgreSQL schema `crm`, migration output `verticals/crm/drizzle`, and migration journal `drizzle.__drizzle_migrations_crm`; use `DATABASE_ADMIN_URL` for migration/schema verification and the non-superuser `DATABASE_URL` for the application pool, with no localhost fallback.
- [ ] Extend the root database scripts and `scripts/verify-application-db-schema.mts` so CRM generation, migration, runtime grants, integration tests, and exact schema verification run alongside—but never merge with—Core and Auth ownership.
- [ ] Add database boundary tests proving only CRM code imports the CRM Drizzle schema/repositories and business handlers receive owner-local scoped services rather than a pool, executor, or transaction constructor.

### 4. Implement the exact CRM schema and invariants

- [ ] Define `crm.customers` with UUID ID, `tenant_id`, required trimmed company `name`, optional normalized `company_registration_number`, `tax_identification_number`, email, phone, website, optional structured address (`address_line_1`, `address_line_2`, city, region, postal code, ISO country code), optimistic `version`, created/updated timestamps, and nullable `deleted_at`.
- [ ] Add a partial unique index on normalized `company_registration_number` for non-deleted rows within one tenant. Do not make name, email, phone, or tax identification number unique.
- [ ] Define `crm.contacts` with tenant/customer foreign keys, first and last name, email, phone, job title, `is_primary_contact`, version/timestamps/tombstone, and the invariant that at least one trimmed name part exists and at most one non-deleted Contact is primary for a Customer.
- [ ] Define `crm.deals` with tenant/legal-entity/customer foreign keys, optional Contact foreign key, required title, description, non-negative expected value plus uppercase ISO 4217 currency, optional expected close date, fixed Deal status, version/timestamps/tombstone, and same-tenant/same-Customer Contact constraints.
- [ ] Define `crm.offers` with tenant/legal-entity/Deal foreign keys, immutable positive revision number unique per non-deleted Deal, title, description, non-negative amount, uppercase ISO 4217 currency, optional validity date, fixed Offer status, version/timestamps/tombstone, and same-tenant/same-Legal-Entity Deal constraints.
- [ ] Define `crm.activities` with tenant/legal-entity/Customer foreign keys, optional Contact and Deal foreign keys, fixed Activity type, required subject, optional details, required occurrence timestamp defaulted by the server, version/timestamps/tombstone, and cross-field constraints that referenced Contact/Deal belong to the same Customer and scope.
- [ ] Apply enabled and forced tenant RLS to Customer and Contact tables. Apply enabled and forced tenant plus legal-entity RLS to Deal, Offer, and Activity tables. Add composite tenant/legal-entity uniqueness and foreign keys where they protect cross-scope references even if application checks are bypassed.
- [ ] Generate the migration from typed Drizzle schema, inspect it for exact schema/journal/RLS/index/constraint behavior, and add schema verification tests. Do not replace expressible Drizzle definitions with handwritten SQL.

### 5. Generate all dedicated CRM Actions

- [ ] Generate Customer Actions with `mise exec -- pnpm scaffold:action -- --vertical crm --action create-customer --legal-entity-scope required`, then repeat for `edit-customer` and `delete-customer`.
- [ ] Generate Contact Actions the same way for `create-contact`, `edit-contact`, `delete-contact`, and `change-customer-primary-contact`.
- [ ] Generate Deal Actions the same way for `create-deal`, `edit-deal`, `delete-deal`, and `change-deal-status`.
- [ ] Generate Offer Actions the same way for `create-offer`, `edit-offer`, `delete-offer`, and `change-offer-status`.
- [ ] Generate Activity Actions the same way for `create-activity`, `edit-activity`, and `delete-activity`.
- [ ] Confirm all 18 Actions are `crm.core.*`, registered owner-locally, manifest-published by real typed values, idempotency-required, legal-entity-scope-required, and fail closed before a manually authored handler is bound.
- [ ] Confirm the Action scaffold generated every strict Action-specific Effect API contract, server adapter, and client. Do not create a generic mutation endpoint, generate a handler, or call handlers directly from transport code.

### 6. Implement Customer and Contact Actions with tests

- [ ] Implement `CreateCustomer`, `EditCustomer`, and `DeleteCustomer`; keep deletion out of edit payloads, enforce normalized registration-number uniqueness with typed `409`, reject stale versions with typed `409`, and return typed `404`/`422` outcomes as applicable.
- [ ] Implement `CreateContact`, `EditContact`, and `DeleteContact`; keep primary designation out of ordinary edit payloads and reject missing/deleted/cross-tenant Customers.
- [ ] Implement `ChangeCustomerPrimaryContact` as the sole primary-contact mutation. Atomically clear the old primary and set the selected non-deleted Contact, or clear the designation when explicitly requested, while verifying Customer ownership and expected versions.
- [ ] Emit declared owner-local past-tense Domain Events for successful creates, deletes, and primary-contact changes. Keep ordinary edit facts in Action audit unless another current requirement consumes them.
- [ ] Add Action unit and PostgreSQL integration tests for normalization, duplicate registration numbers, missing name parts, primary uniqueness, concurrency conflicts, soft deletion, tenant isolation, selected-Legal-Entity authorization, idempotent replay, Action permission denial, and rollback of business/event/audit/evidence writes on failure.

### 7. Implement Deal and Offer Actions with tests

- [ ] Implement `CreateDeal` with initial status `New`; implement `EditDeal` without a status field; validate that an optional Contact belongs to the selected Customer and that the Deal's stored Legal Entity comes only from trusted scope.
- [ ] Implement `ChangeDealStatus` as the only Deal status mutation. Allow any transition among `New`, `Qualified`, `Offer sent`, `Negotiation`, `Won`, and `Lost`, including reopening Won/Lost Deals, and emit a Deal-status Domain Event containing safe previous/new status data.
- [ ] Implement Deal soft deletion without cascading to Offers or Activities; prevent new child mutations beneath a deleted Deal and preserve historical labels/references.
- [ ] Implement `CreateOffer` with server-allocated, concurrency-safe revision number and initial status `Draft`; implement `EditOffer` only for a non-deleted Draft and without status/revision fields.
- [ ] Implement `ChangeOfferStatus` with only `Draft -> Sent|Withdrawn` and `Sent -> Accepted|Rejected|Withdrawn|Superseded`; require a higher Offer revision before `Superseded`; treat Accepted, Rejected, Withdrawn, and Superseded as terminal; enforce at most one accepted non-deleted Offer per Deal.
- [ ] Do not implicitly change Deal status, another Offer status, or create an Activity from an Offer Action. Each required state change remains a separate Action.
- [ ] Add Action and integration tests for every Deal status pair, every allowed/forbidden Offer transition, Draft-only edit, revision allocation races, accepted-Offer uniqueness, deleted parents, cross-Customer Contact, cross-Legal-Entity access, money/currency validation, optimistic conflicts, and transaction rollback.

### 8. Implement Activity Actions and the timeline read model

- [ ] Implement `CreateActivity`, `EditActivity`, and `DeleteActivity` for fixed types `Note`, `Call`, `Email`, `Meeting`, and `Other`. Activity records document interactions that happened; they do not send email, place calls, or schedule meetings.
- [ ] Keep type, subject, details, occurrence time, optional Contact, and optional Deal editable only through `EditActivity`; keep deletion separate. Reject references that do not belong to the Activity's Customer and Legal Entity.
- [ ] Build a paginated, deterministic Customer timeline read model from non-deleted Activities plus Deal and Offer lifecycle Domain Events, ordered by occurrence/event time and stable ID. Do not use Core audit rows as a substitute for CRM domain history.
- [ ] Include Deal status changes in the Customer timeline as agreed. Include Offer creation/status events that communicate commercial progression; exclude routine Customer/Contact/Deal field edits.
- [ ] Add unit and integration tests for all Activity types, optional links, ordering ties, pagination boundaries, soft deletion, cross-scope references, empty timeline, and mixed Activity/Deal/Offer event rendering.

### 9. Generate and implement governed CRM read APIs

- [ ] Run `mise exec -- pnpm scaffold:module-api -- --vertical crm --name customer-directory`, `... --name deal-workspace`, and `... --name activity-timeline` before adapting the generated contracts and clients.
- [ ] Implement paginated Customer/Contact list and detail operations, Deal list/detail, Offer revision list, and Customer timeline operations through `defineRead` and owner-local services. Use the current selected Legal Entity for module authorization even when querying tenant-wide Customer/Contact tables.
- [ ] Keep list inputs bounded; use cursor pagination and deterministic ordering; exclude soft-deleted rows from ordinary results and return typed safe labels for deleted linked records in historical views.
- [ ] Map authentication, module state, permission, validation, not-found, version/state conflict, database/evidence unavailability, and unexpected defects exhaustively to declared Problem Details schemas and generated client error unions.
- [ ] Add BFF contract/client/server tests for exact decoding, excess properties, legal-entity context, 401 challenge, 403 denial, 404 absence, 409 conflict, 422 semantic rejection, retryable 503, sanitized 500, and no private implementation in browser bundles.

### 10. Establish v1 CRM authorization and future restriction path

- [ ] Configure `crm.core` module access per selected Legal Entity and restrict all 18 Actions through their exact encoded Action objects and executor relations; do not rely on the unconfigured-Action compatibility path in production.
- [ ] Implement the approved Core/SpiceDB resource-access behavior so a Customer, Contact, or Deal without a record restriction marker inherits authorized CRM module access, while a future explicit restriction marker switches that resource to its reader/writer relations. Reuse the fail-closed restricted/unrestricted decision pattern already used by Actions rather than interpreting SpiceDB unavailability as unrestricted.
- [ ] Keep Customer/Contact storage tenant-wide: a user authorized for CRM in any selected Legal Entity sees the same Customer/Contact identity. Filter Deal, Offer, Activity, value totals, and timeline entries to the selected Legal Entity.
- [ ] Add SpiceDB and runtime tests for module denial, unrestricted resource access, explicitly restricted resource denial/allow, unavailable/conditional decisions, cross-tenant/entity IDs, and later-safe migration from unrestricted to restricted resources.

### 11. Declare resources and resource-detail providers

- [ ] Add owner-authored manifest resource descriptors for `crm.core.customer`, `crm.core.contact`, and `crm.core.deal`, with stable labels, owning module, link/detail capabilities, and no private schema or route metadata.
- [ ] Generate the approved Customer, Contact, and Deal resource-detail providers from Task 1 so authorized ResourceRefs resolve to useful detail views. Generate the Customer timeline provider only after its supported generator exists.
- [ ] Add provider and Shell integration tests for selected-Legal-Entity filtering, provider failure, permission denial, explicit future resource restriction, deleted resources, and direct detail/timeline resolution.

### 12. Generate and implement CRM pages

- [ ] Run `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customers` and `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page deals` before adapting either page.
- [ ] Build the Customers page with semantic Table lists, Customer create/edit Dialogs, explicit deletion confirmation, Customer details, Contact maintenance, and the mixed relationship timeline. Keep selected record/page state in the URL where it is shareable.
- [ ] Build the Deals page with Customer-aware filtering, semantic Deal table, compact status Badges, Deal create/edit/delete/status actions, Offer revision list, Draft edit, and explicit Offer status controls.
- [ ] Use `FormInput` for single-line fields, `FormTextarea` for descriptions/details, `FormNumericInput` with numeric values and locale/currency constraints for amounts, and `Select` with array values for fixed enums. Use UI-kit Button loading props, Toast for transient Action feedback, and StatusText for inline errors/empty/unavailable states.
- [ ] Keep route/feature integration responsible for generated Effect clients, mutation state, invalidation, typed error mapping, navigation, and analytics. Pass plain view models and semantic callbacks to reusable presentation.
- [ ] Add English and Czech translations for all visible and accessible copy. Do not expose IČ/DIČ as code field names; the canonical API/entity fields are `companyRegistrationNumber` and `taxIdentificationNumber`, while localized labels may use familiar jurisdiction-specific wording.
- [ ] Add component/route tests for loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, Action success, destructive confirmation, keyboard/focus behavior, narrow layout, long company/contact names, and read-only/deprecated module states.

### 13. Verify deployment, isolation, and complete behavior

- [ ] Add CRM package scripts and focused unit/integration test commands using only generator-established conventions; do not invent a Promise-only test/runtime seam.
- [ ] Prove CRM builds and runs as an independently deployable vertical, serves `/.well-known/ontos-module-manifest.json`, receives only audience-scoped Shell assertions for app ID `crm`, and does not import another deployment's manifest, registration, schema, repository, or handler.
- [ ] Prove every mutation route invokes exactly one registered Action intent, while compound intent such as changing the primary Contact remains one atomic dedicated Action and never leaks into generic edit.
- [ ] Inspect generated migrations, package exports, Module Federation exposes, public manifest serialization, Shell allowlist, browser bundles, i18n catalogs, and topology ownership for accidental private surface expansion.
- [ ] Run every Validation Command below and resolve all failures without weakening repository gates.

## Testing Strategy

### Unit Tests

Test Effect Schemas, normalization, value objects, fixed enums, lifecycle transition functions,
money/currency validation, address validation, timeline merge/order/pagination, view-model mapping,
typed error mapping, and reusable presentation states. Test every generated Action descriptor for
the correct owner, key, required legal-entity scope, idempotency, event/error declarations, and
private handler registration.

### Integration Tests

Use PostgreSQL and SpiceDB integration tests to prove CRM schema ownership, forced RLS, tenant-wide
Customer/Contact identity, legal-entity Deal/Offer/Activity isolation, same-scope foreign keys,
Action idempotency/rollback/audit/evidence/events, module and Action permissions, unrestricted v1
resource access, future explicit resource restrictions, strict BFF contracts, resource detail, and
timeline behavior. Add browser tests for the generated pages and Shell entrypoint
gates after the vertical is installed.

### Edge Cases

- Customer registration number differs only by formatting/case or is absent on multiple Customers.
- A Contact has only first name or only last name; both empty is rejected.
- Two requests concurrently try to make different Contacts primary.
- A Deal selects a Contact from another Customer or receives stale expected version.
- The same Customer has Deals and Activities in two Legal Entities; each selected context sees only its own commercial history.
- A won/lost Deal is reopened to any fixed status.
- Two Offer revisions are created concurrently or two Offers are accepted concurrently.
- A sent/terminal Offer is edited or moved through a forbidden transition.
- A superseded Offer has no higher revision.
- An Activity references a Contact/Deal outside its Customer or Legal Entity.
- Soft-deleted parents remain referenced historically but cannot receive new child mutations.
- Module state is read-only, deprecated, inactive, suspended, quarantined, archived, or missing.
- Assertion, SpiceDB, database, evidence persistence, or module-contract discovery is unavailable.

## Acceptance Criteria

- [ ] `crm` exists as an independently deployable UltraModern.js MicroVertical and publishes module `crm.core` through a valid versioned OntOS module contract.
- [ ] CRM owns exactly Customer, Contact, Deal, Offer, and Activity; Product, Pipeline, Tag, Attachment, Address, and ContactMethod are not entities in this version.
- [ ] Customer is a tenant-wide company, Contact belongs to exactly one Customer, and no CRM API or UI uses `Party` as the domain term.
- [ ] Customer supports the agreed company fields using canonical English field names `companyRegistrationNumber` and `taxIdentificationNumber`.
- [ ] Non-deleted Customer registration numbers are unique within a tenant when present; names, emails, and phones may repeat.
- [ ] Deal has the fixed statuses New, Qualified, Offer sent, Negotiation, Won, and Lost, and its dedicated status Action allows any transition including reopen.
- [ ] Offer has fixed statuses Draft, Sent, Accepted, Rejected, Withdrawn, and Superseded; only Draft is editable and all agreed transition/revision rules are enforced.
- [ ] Activity records historical Notes, Calls, Emails, Meetings, and Other interactions without performing external communication or scheduling.
- [ ] Every create, edit, delete, primary-contact change, Deal status change, and Offer status change uses its own registered typed Action; edit payloads cannot mutate status or deletion state.
- [ ] All Delete Actions are soft deletes, no restore capability exists, and no database cascade erases CRM history.
- [ ] Customer/Contact data are tenant-only and shared; Deal/Offer/Activity data are isolated by selected Legal Entity through forced RLS and trusted operation scope.
- [ ] Users with CRM module access for the selected Legal Entity can see all v1 CRM records eligible for that context, and the authorization model can later mark individual public resources restricted in SpiceDB.
- [ ] Customer timeline shows Activities and meaningful Deal/Offer lifecycle events in deterministic order without substituting audit rows for business history.
- [ ] All reads and writes use generated Effect BFF clients/contracts, declared typed errors, correct Problem Details statuses, and owner-local scoped services.
- [ ] Customers and Deals pages cover loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, accessibility, responsive layout, and read-only module states using existing `@techsio/ui-kit` components.
- [ ] English and Czech translations contain every user-facing and accessible CRM string.
- [ ] Database, Action, BFF, authorization, timeline, UI, contract, boundary, type, lint, format, build, and repository checks pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck any approved Codesmith prerequisite and its generated-output fixtures.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — validate generator help, safety, composition, and compilation.
- `mise exec -- pnpm db:generate` — prove CRM uses its typed owner-local Drizzle schema and produces deterministic migrations.
- `mise exec -- pnpm db:migrate` — apply Core, Auth, and CRM migrations and refresh runtime-role grants.
- `mise exec -- pnpm db:verify` — compare live application schemas with exact Core, Auth, and CRM typed inventories.
- `mise exec -- pnpm db:test` — run database integration and isolation tests, including the CRM vertical after root orchestration is extended.
- `mise exec -- pnpm i18n:boundaries` — verify CRM translations remain owner-local and complete.
- `mise exec -- pnpm api:check` — verify strict Effect API topology and prevent ad hoc handlers/fetch clients.
- `mise exec -- pnpm database-access:check` — reject cross-owner schemas, executors, direct SQL access, and unscoped services.
- `mise exec -- pnpm module-entrypoints:check` — verify every CRM page/API/resource/timeline/Action entrypoint is generated, governed, and owner-correct.
- `mise exec -- pnpm check:module-contracts` — validate `crm`/`crm.core` manifest identity, serialization, registration, and allowlist behavior.
- `mise exec -- pnpm contract:check` — validate the complete UltraModern workspace and deployment seams.
- `mise exec -- pnpm build` — build Shell and every generated vertical, Module Federation type surface, and performance readiness checks.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Approved implementation boundary: Codesmith generates Action descriptors plus deterministic Action-specific transport/client/registration wiring, but never handlers. CRM schemas, repositories, services, and private Effect handlers are manually authored owner-local code; Drizzle generates migrations. Resource-detail/timeline business providers begin only from an approved generated entrypoint.
- `crm` is the deployment `appId`; `crm.core` is the business `moduleId`.
- All CRM operations require a selected Legal Entity for current Shell/module authorization. This does not duplicate tenant-wide Customers or Contacts per Legal Entity.
- V1 access is broad within an authorized CRM module/Legal Entity. Per-Customer and per-Deal SpiceDB restrictions are deliberately deferred, but stable ResourceRefs and an explicit restriction marker path must preserve that future option.
- Deal expected value and Offer quoted amount are distinct required non-negative monetary values.
- Only one non-deleted Offer may be Accepted per Deal; this conservative invariant can be revisited with a concrete multi-award sales scenario.
- Search and search providers are out of scope. File uploads, offer documents, line items, product catalogs, generated PDFs, external email/call/calendar integration, imports, exports, configurable stages, tags, restore, merge/deduplication UI, and communication automation are also out of scope.
- The repository-level glossary currently uses `Party`; the CRM bounded context deliberately uses Customer and Contact as agreed. Broader cross-module vocabulary reconciliation remains separate work.
