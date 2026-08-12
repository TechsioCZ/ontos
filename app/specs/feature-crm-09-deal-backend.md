---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 09 Deal backend

## Feature Description

Implement ticket 9, "Implement the Deal backend," from `app/tickets.md`. Add the full
Legal-Entity-owned Deal persistence and callable backend path: schema/migration/forced RLS,
transaction-scoped repository/service, generated Create/Edit/Delete Action contracts/transports,
manual private Effect handlers, generated deal-workspace list/detail/resource-detail BFF, typed
errors, authorization/evidence, and tests. Lifecycle status changes remain outside this leaf.

## User Story

As an authorized CRM sales user
I want to create and maintain Deals for the selected Legal Entity
So that potential sales are tracked against shared Customers without leaking commercial data across entities

## Problem Statement

CRM has shared Customers/Contacts but no commercial record. Deal must derive tenant/Legal Entity
only from trusted context, optionally reference an active Contact of the chosen Customer, start in
`New`, support optimistic edits/deletion, and isolate values/records with forced legal-entity RLS.

## Solution Statement

Generate the three dedicated Deal Actions and the `deal-workspace` module API. Add `crm.deals` with
composite scope constraints, money/currency validation, status fixed to the agreed enum, and forced
tenant/legal-entity RLS. Bind manual handlers to scoped services and implement bounded list with an
exact Customer filter, direct detail, and generated resource detail through typed Effect contracts.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Deal fields, ownership, status boundary, reads, and invariants.
- `tickets.md` — corresponding ticket 9; blocked by tickets 3 and 5.
- `verticals/crm/src/db/schema.ts` — Customer/Contact tables and CRM schema catalog.
- `verticals/crm/src/customers/customer-service.ts` — active Customer validation.
- `verticals/crm/src/contacts/contact-service.ts` — active same-Customer Contact validation.
- `verticals/crm/vertical.manifest.ts` and `verticals/crm/vertical.registration.ts` — generated descriptors/private binding.
- `docs/architecture/DATABASE.md` and `docs/architecture/DATA_ACCESS.md` — typed Drizzle, composite scope constraints, scoped services, and RLS.
- `docs/architecture/ACTIONS.md` and `docs/architecture/ERRORS.md` — complete Action and BFF behavior.

### New Files

- `verticals/crm/src/deals/deal-repository.ts` — scoped typed Deal persistence/read access.
- `verticals/crm/src/deals/deal-service.ts` — Deal validation, mutations, and read models.
- `verticals/crm/src/actions/create-deal.handler.ts` — manual private Create handler.
- `verticals/crm/src/actions/edit-deal.handler.ts` — manual private Edit handler.
- `verticals/crm/src/actions/delete-deal.handler.ts` — manual private Delete handler.
- `verticals/crm/tests/unit/deal-*.test.ts` — schema/service/contract/error tests.
- `verticals/crm/tests/integration/deal-*.test.ts` — PostgreSQL/RLS/Action/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Generate Deal Actions and API, define exact schemas/errors/status vocabulary, add Deal table,
constraints, indexes, forced RLS, and generated migration.

### Phase 2: Core Implementation

Implement scoped repository/service and manual Create/Edit/Delete handlers. New status is always
`New`; edit cannot change status/deletion; Contact must be active and belong to chosen Customer.

### Phase 3: Integration

Implement exact-Customer-filtered pagination, direct/resource detail, generated server/client error
mapping, and full selected-Legal-Entity authorization/isolation/evidence tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate Deal business entrypoints

- [x] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action create-deal --legal-entity-scope required`, then repeat for `edit-deal` and `delete-deal`.
- [x] Run `mise exec -- pnpm scaffold:module-api -- --vertical crm --name deal-workspace` before adapting its generated contract/client/read/server wiring.
- [x] Verify exact `crm.core` ownership, idempotency-required writes, generated Action-specific transport, and no private handler generation.

### 2. Define Deal contracts, schema, migration, and RLS

- [x] Adapt schemas for Customer ID, optional Contact ID, required trimmed title, optional description, required non-negative expected value, uppercase ISO 4217 currency, optional expected close date, version/timestamps/tombstone, and fixed status output. Create/edit payloads contain no status, deletion, tenant, or legal-entity fields.
- [x] Add `crm.deals` with tenant/legal-entity/customer/contact scope columns, server-generated UUID, initial status `New`, non-negative money check, currency/date checks, optimistic version/timestamps/tombstone, and deterministic list indexes.
- [x] Add composite uniqueness/FKs needed to prove Customer tenant and optional Contact same tenant/same Customer even if service validation is bypassed; use `ON DELETE` behavior that never cascades away history.
- [x] Enable and force RLS requiring both transaction-local `ontos.tenant_id` and `ontos.legal_entity_id`; generate/inspect the migration and extend exact schema/RLS/FK verification tests.

### 3. Implement scoped repository/service and manual handlers

- [x] Implement typed Drizzle repository/service methods from the Core-supplied scoped transaction; never accept or import a pool/executor and never derive scope from payload.
- [x] Create validates active Customer and eligible optional Contact, assigns trusted scope and `New`; Edit validates expected version and mutable fields only; Delete tombstones the Deal without cascading Offers/Activities or changing status.
- [x] Reject deleted Customer/Contact/Deal and cross-Customer Contact, and preserve safe labels for later historical children. Emit declared create/delete Domain Events; ordinary edits remain audit-only.
- [x] Map `400/401/403/404/409/422/503/500` semantics exhaustively through generated Problem Details/client unions, including money/currency, stale/hash conflicts, permission/check failures, persistence/evidence uncertainty, and caught defects.

### 4. Implement governed Deal reads

- [x] Adapt `deal-workspace` for bounded cursor pagination ordered deterministically by updated time/ID, optional exact Customer ID filter (not search), direct detail, and active-row exclusion.
- [x] Implement the generated Deal resource-detail provider with safe Customer/Contact labels, selected-Legal-Entity module/resource checks, metadata-only evidence, and no cross-entity values.
- [x] Keep filter/selection input bounded and schema-exact; clients expose typed Effects only and browser bundles contain no repositories/handlers/server adapters.

### 5. Add focused tests beside behavior

- [x] Add unit tests for exact schemas, money/currency/date validation, initial status, mutable-field separation, optional Contact eligibility, cursor/filter behavior, descriptors, events, and typed error mappings.
- [x] Add PostgreSQL/RLS/Action/BFF tests for cross-Customer Contact, deleted parents, trusted-scope derivation, selected-Legal-Entity isolation, cross-tenant/entity denial, optimistic conflicts, idempotent replay/hash conflict, permission denial/check unavailability, soft delete/no cascade, rollback/evidence atomicity, resource detail, all declared HTTP statuses, client decoding, and private bundle isolation.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test schemas/value validation, status/mutation separation, service decisions, exact Customer filter,
pagination, Action descriptors/events, error mapping, and detail view models.

### Integration Tests

Use PostgreSQL/Core runtime/strict BFF fixtures for composite FKs, forced tenant/legal-entity RLS,
Actions/evidence/idempotency, authorization, generated client, resource detail, and isolation.

### Edge Cases

- Optional Contact belongs to another Customer or is deleted.
- Customer is shared but Deal exists only in another selected Legal Entity.
- Currency is malformed or value negative.
- Customer/Contact is deleted between validation and write.
- Edit/delete races another mutation.

## Acceptance Criteria

- [x] Deal stores all agreed fields, derives trusted scope, and always starts in `New`.
- [x] Generated Create/Edit/Delete Actions bind manual handlers; edit/delete cannot change status.
- [x] List supports pagination and exact Customer filter, and detail/resource detail isolate selected Legal Entity.
- [x] Composite scope constraints, forced RLS, typed errors, idempotency, rollback, authorization, and BFF tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Deal schema/service/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run Deal PostgreSQL/RLS/Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic Deal migration.
- `mise exec -- pnpm db:verify` — verify Deal table/FK/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped owner-local database access.
- `mise exec -- pnpm api:check` — validate generated strict Effect transports/clients.
- `mise exec -- pnpm module-entrypoints:check` — validate Deal Action/API/resource entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 3 and 5 must both be complete.
- Customer filtering is an exact selector, not search. No search UI/provider/query behavior is allowed.
- Ticket 11 exclusively owns Deal status changes; Offer/Activity behavior is deferred.

## Implementation Evidence

### Summary

- Implemented the complete Deal backend from the `develop` baseline: generated Create/Edit/Delete Actions, Legal-Entity-owned persistence with forced tenant-and-Legal-Entity RLS, scoped repository/service behavior, governed reads, resource detail, registration, and public Effect transports.
- Added the closed ISO 4217 currency vocabulary as a schema-owned PostgreSQL enum, deterministic active-Deal pagination with exact Customer filtering, optimistic concurrency, tombstones, safe linked labels, exhaustive Problem Details, evidence, and create/delete Domain Events.
- Kept lifecycle transitions outside this leaf: every Deal starts in `New`, and edit/delete inputs cannot change status.

### Changed Files and Diff Stat

- `verticals/crm/drizzle/**`, `src/db/schema.ts`, and `shared/deal-currencies.ts`: Deal table, enum, migration, snapshot, constraints, indexes, composite FKs, and forced RLS.
- `verticals/crm/shared/apis/**`, `api/**`, and `src/api/**`: generated Action/read contracts, servers, clients, governed read handlers, correlation requirements, and API composition.
- `verticals/crm/src/actions/**`, `src/deals/**`, and Contact lookup support: manual private handlers, registrations, scoped persistence, parent locking/validation, events, and read models.
- `verticals/crm/tests/**`, schema verification, manifest, and registration: unit/integration coverage and module publication.
- `specs/feature-crm-09-deal-backend.md`: implementation state and evidence.
- Final integrated diff stat: 49 files changed, 5,950 insertions(+), 57 deletions(-).

### Tests and Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — PASS; integrated Node unit suite 39/39 and Rstest suite 32/32.
- `mise exec -- pnpm --filter @app/crm test:integration` with the documented local PostgreSQL and SpiceDB fixtures — PASS, 8/8.
- `mise exec -- pnpm db:migrate` — PASS; generated Deal migration applied successfully.
- `mise exec -- pnpm db:generate` — PASS; all schemas reported no changes after the checked-in migration.
- `mise exec -- pnpm db:verify` with the documented local PostgreSQL fixture and safe local auth placeholders — PASS; Core 18, Auth 6, CRM 3 typed tables verified.
- `mise exec -- pnpm database-access:check` — PASS.
- `mise exec -- pnpm api:check` — PASS.
- `mise exec -- pnpm module-entrypoints:check` — PASS.
- `mise exec -- pnpm check` — PASS, including formatting, lint, type checking, boundary gates, and 60/60 canonical Core Action lifecycle tests.
- `GIT_DIR=/tmp/codex-ontos-crm09-merge-build-9e31625 ULTRAMODERN_SOURCE_REVISION=9e31625e43d62dc0d905380bdd21e358b30ca4b9 mise exec -- pnpm --filter @app/crm build` — PASS, including production compilation, module contract/public assets, and deploy packaging after integration with `develop`.

### Review Evidence

- Reviewed against this specification, root/app `AGENTS.md`, and the referenced MicroVertical, Action, error, data-access, database, module-entrypoint, module-manifest, outbox-worker, and UltraModern guidance.
- Spec/acceptance review: PASS after replacing a shape-only currency check with the authoritative closed ISO 4217 vocabulary and expanding Deal-specific Action/BFF/database coverage.
- Standards/architecture review: PASS after enforcing correlation IDs, consolidating parent locking, correcting integration-test ownership, simplifying client logic, and replacing string-built DDL with the typed Drizzle enum declaration.
- Final independent Spec and Standards re-reviews both reported PASS with no remaining findings.
- Final diff audit found no changes outside `app/`, no edits to read-only `mvp/` or `mvp2/`, no unrelated feature expansion, and no remaining review findings.

### Deviations and Notes

- The standard build release envelope cannot infer a promotable revision from a dirty worktree. The production build was therefore verified with the exact `develop` source revision and an isolated nonexistent `GIT_DIR`; generated build output remains ignored.
- Generic Action lifecycle semantics (idempotent replay/hash conflict, authorization, transaction rollback, and atomic evidence) remain covered by the canonical Core Action runtime gate; Deal-specific handler/service behavior and generated HTTP transports are covered locally without importing Core-private implementation files.
