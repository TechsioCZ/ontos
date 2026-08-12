---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 05 Contact backend

## Feature Description

Implement ticket 5, "Implement the Contact backend," from `app/tickets.md`. Add tenant-wide Contacts
belonging to exactly one Customer through the complete schema/migration/RLS, scoped
repository/service, generated Create/Edit/Delete Actions, manual private Effect handlers, Customer
Contact list/direct detail/resource-detail BFF reads, typed errors, authorization, evidence, and
tests. Ordinary Contact operations must never change primary designation.

## User Story

As an authorized CRM user
I want to maintain people associated with a Customer
So that customer relationships have accurate, reusable contact information

## Problem Statement

Customer records exist without people to contact. Contact identity must remain tenant-wide and
Customer-owned, reject missing/deleted/foreign parents, preserve historical labels after soft
deletion, and reserve primary designation for ticket 7's dedicated atomic Action.

## Solution Statement

Generate three dedicated Contact Actions, extend the existing generated `customer-directory` API,
and implement `crm.contacts` with forced tenant RLS and same-tenant Customer foreign keys. Bind
manual handlers to a transaction-scoped Contact service. Provide bounded Customer Contact lists,
direct detail, and the generated public resource-detail provider with exhaustive typed errors.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Contact fields, ownership, primary boundary, reads, and non-goals.
- `tickets.md` — corresponding ticket 5; blocked by ticket 3.
- `verticals/crm/src/db/schema.ts` — CRM schema catalog containing Customer from ticket 3.
- `verticals/crm/src/customers/customer-service.ts` — active Customer lookup semantics to reuse through an owner-local interface.
- `verticals/crm/shared/apis/customer-directory.ts` — generated Customer-directory contract to extend.
- `verticals/crm/src/api/customer-directory-client.ts` — generated Effect client consumed by later UI.
- `verticals/crm/vertical.manifest.ts` — Contact Actions/resource contract publication.
- `verticals/crm/vertical.registration.ts` — private handler/read/provider binding.
- `docs/architecture/DATA_ACCESS.md` — tenant RLS and required operation context.
- `docs/architecture/ACTIONS.md` — Action atomicity, idempotency, and evidence.

### New Files

- `verticals/crm/src/contacts/contact-repository.ts` — transaction-scoped typed Contact access.
- `verticals/crm/src/contacts/contact-service.ts` — Contact validation, mutation, and read behavior.
- `verticals/crm/src/actions/create-contact.handler.ts` — manual private Create handler.
- `verticals/crm/src/actions/edit-contact.handler.ts` — manual private Edit handler.
- `verticals/crm/src/actions/delete-contact.handler.ts` — manual private Delete handler.
- `verticals/crm/tests/unit/contact-*.test.ts` — schemas, services, contracts, and errors.
- `verticals/crm/tests/integration/contact-*.test.ts` — PostgreSQL/RLS/Action/BFF behavior.

## Implementation Plan

### Phase 1: Foundation

Generate Contact Actions, define exact schemas/errors, add the Contact table/FKs/RLS/migration, and
extend the completed Customer-directory and resource-detail contracts.

### Phase 2: Core Implementation

Implement scoped repository/service and manual handlers. Create defaults primary to false; edit and
delete have no primary mutation capability; every operation verifies an active same-tenant Customer.

### Phase 3: Integration

Bind list/detail/provider reads and Actions owner-locally, preserve safe historical labels, and prove
full BFF/error/authorization/atomicity/isolation behavior with focused tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate dedicated Contact Actions

- [x] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action create-contact --legal-entity-scope required`, then repeat for `edit-contact` and `delete-contact`.
- [x] Confirm generated descriptors/transport/client/registration are `crm.core`-owned and idempotency-required, and create no private handler or generic mutation endpoint.

### 2. Define Contact contracts, schema, migration, and RLS

- [x] Adapt generated payload/result/error schemas for Customer ID, optional trimmed first/last name with at least one present, optional email/phone/job title, expected version where applicable, timestamps, tombstone, and safe Customer label. Exclude `isPrimaryContact`, tenant/legal-entity IDs, and deletion state from create/edit payloads.
- [x] Add `crm.contacts` with UUID ID, tenant/Customer composite foreign keys, `is_primary_contact` default false, optimistic version/timestamps/tombstone, name check constraint, and typed indexes for active Customer pagination. Ticket 7 owns the partial primary uniqueness index and mutation.
- [x] Enable and force tenant-only RLS using `ontos.tenant_id`; operation descriptors still use `legalEntityScope: required` for selected-context module authorization.
- [x] Generate and inspect the Drizzle migration; add exact schema/FK/check/RLS verification tests and no cascade that erases Contacts when a Customer is soft-deleted.

### 3. Implement repository/service and manual handlers

- [x] Implement typed Drizzle repository/service methods over the Core-supplied scoped transaction only; share active-Customer validation without importing a global executor or duplicating Customer persistence.
- [x] Manually author and bind Create/Edit/Delete Effect handlers. Create always stores non-primary; Edit cannot change Customer ownership, primary, or deletion state; Delete tombstones only the Contact and requires expected version.
- [x] Reject missing/deleted/cross-tenant Customer or Contact safely; map structural validation `400`, authentication `401`, permission `403`, absence `404`, stale/hash/state conflict `409`, semantic invalidity `422`, unavailable `503`, and caught defect `500` through declared Problem Details/client errors.
- [x] Emit declared create/delete Domain Events and Action/data-access evidence; keep ordinary edit in audit only and prove rollback removes all business/event/audit/evidence writes.

### 4. Add governed Contact reads

- [x] Extend `customer-directory` with bounded deterministic cursor pagination of active Contacts for one active Customer and direct Contact detail; exclude tombstones from ordinary results.
- [x] Implement the generated Contact resource-detail provider with safe historical Customer/Contact labels and selected-Legal-Entity module/resource authorization.
- [x] Record metadata-only read evidence, prevent cross-tenant/cross-Customer leakage, and expose only the generated Effect client contract.

### 5. Add focused tests beside behavior

- [x] Add unit tests for name-part validation, optional normalization, payload exclusion of primary/deletion, deterministic pagination, parent validation, descriptor/error mappings, and historical labels.
- [x] Add PostgreSQL/RLS/Action/BFF tests for missing/deleted/foreign Customer, tenant sharing across permitted Legal Entities, cross-tenant denial, optimistic conflicts, soft deletion, idempotent replay/hash conflict, permission denial/check unavailability, rollback/atomic evidence, 401/403/404/409/422/503/500 contracts, client decoding, and private bundle isolation.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Cover exact schemas, normalization, name invariant, service decisions, pagination, typed errors,
Action descriptor separation, and resource view models.

### Integration Tests

Use PostgreSQL/Core runtime/strict BFF fixtures for FKs, forced RLS, Actions, evidence/events,
idempotency, authorization, generated client decoding, resource detail, and browser isolation.

### Edge Cases

- Only first name or only last name is present; both blank is rejected.
- Customer becomes deleted between validation and write.
- The same Contact is edited/deleted concurrently.
- A deleted Contact is referenced historically but absent from ordinary reads.
- A payload attempts to set primary designation or trusted scope.

## Acceptance Criteria

- [x] Contact belongs to exactly one active same-tenant Customer and stores every agreed field/version/tombstone.
- [x] Generated Create/Edit/Delete Actions bind manual handlers and cannot mutate primary designation.
- [x] Customer Contact list, direct detail, and resource detail exclude deleted rows and preserve safe historical labels.
- [x] Forced tenant RLS, selected-context authorization, idempotency, concurrency, rollback, and typed BFF tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Contact schema/service/contract unit tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run Contact PostgreSQL/RLS/Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic Contact migration output.
- `mise exec -- pnpm db:verify` — verify Contact FKs/checks/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped owner-local access.
- `mise exec -- pnpm api:check` — validate strict Effect contracts/clients.
- `mise exec -- pnpm module-entrypoints:check` — validate Contact Action/API/resource entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 3 must be complete.
- Ticket 7 exclusively owns primary designation and its database uniqueness invariant.
- No Contact UI, Deal, Activity, search, restore, merge, external communication, Policy, or Outbox Message belongs here.

## Implementation Evidence

### Summary

- Implemented the complete Contact backend from the `develop` baseline: generated Create/Edit/Delete Actions, typed Contact persistence with forced tenant RLS, scoped repository/service behavior, governed reads, resource detail, registration, and public Effect transports.
- Kept primary designation reserved: ordinary creation always stores `false`, and edit/delete contracts cannot mutate it.
- Added deterministic active-Contact pagination, direct detail, safe historical labels, optimistic concurrency, tombstones, exhaustive Problem Details, evidence, and create/delete Domain Events.

### Changed Files and Diff Stat

- `verticals/crm/drizzle/**` and `src/db/schema.ts`: Contact table, migration, snapshot, constraints, indexes, FK, and forced RLS.
- `verticals/crm/shared/apis/**`, `api/**`, and `src/api/**`: generated Action/read contracts, servers, clients, read handlers, and API composition.
- `verticals/crm/src/actions/**`, `src/contacts/**`, and Customer lookup files: private handlers, registrations, scoped persistence, validation, events, and parent checks.
- `verticals/crm/tests/**`, schema verification, manifest, and registration: focused unit/integration coverage and module publication.
- `specs/feature-crm-05-contact-backend.md`: implementation state and evidence.
- Diff stat: 46 files changed, 4,705 insertions(+), 38 deletions(-).

### Tests and Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — PASS, 24/24.
- `mise exec -- pnpm --filter @app/crm test:integration` with isolated PostgreSQL URLs — PASS, 4/4.
- `mise exec -- pnpm db:generate` — PASS; all schemas reported no changes after the checked-in migration.
- `mise exec -- pnpm db:verify` with isolated PostgreSQL URLs and safe local auth placeholders — PASS; Core 18, Auth 6, CRM 2 typed tables verified.
- `mise exec -- pnpm database-access:check` — PASS.
- `mise exec -- pnpm api:check` — PASS.
- `mise exec -- pnpm module-entrypoints:check` — PASS.
- `mise exec -- pnpm check` — PASS, including 60/60 canonical Core Action lifecycle tests.
- `GIT_DIR=/tmp/codex-ontos-build-no-git ULTRAMODERN_SOURCE_REVISION=79887f3368900aade320704ef1e7af3c6b840ec8 mise exec -- pnpm --filter @app/crm build` — PASS, including production compilation, module contract/public assets, and deploy packaging.

### Review Evidence

- Reviewed against this specification, root/app `AGENTS.md`, and the referenced MicroVertical, Action, error, data-access, database, module-entrypoint, module-manifest, outbox-worker, and UltraModern guidance.
- Spec/acceptance review: PASS after adding generated read-client HTTP decoding coverage, bounding resource-detail titles, and strengthening database whitespace checks.
- Standards/architecture review: PASS after canonicalizing cursor validation at the contract boundary, sharing cursor decoding, clarifying the Customer lookup abstraction, and removing private cross-owner test imports.
- Final diff audit found no changes outside `app/`, no edits to read-only `mvp/` or `mvp2/`, no unrelated feature expansion, and no remaining review findings.

### Deviations and Notes

- The standard build release envelope cannot infer a promotable revision from a dirty worktree. The production build was therefore verified with the exact `develop` source revision and an isolated nonexistent `GIT_DIR`; generated build output remains ignored.
- Action lifecycle semantics (idempotent replay/hash conflict, authorization, transaction rollback, and atomic evidence) are covered by the canonical Core Action runtime gate; Contact-specific handler/service behavior and generated HTTP transports are covered locally without importing Core-private implementation files.
