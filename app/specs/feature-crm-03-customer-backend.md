---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 03 Customer backend

## Feature Description

Implement ticket 3, "Implement the Customer backend," from `app/tickets.md`. Add the complete
tenant-wide Customer backend path: typed Drizzle schema/migration/RLS, scoped repository/service,
generated Create/Edit/Delete Action contracts and clients, manually authored private Effect
handlers, governed paginated list/direct detail/resource-detail reads, typed public errors,
authorization, evidence, and focused tests.

## User Story

As an authorized CRM user
I want company Customers to be stored and retrieved consistently across my tenant
So that every permitted Legal Entity works with one shared customer directory

## Problem Statement

The CRM foundation has no business tables or callable Customer capability. Customer identity must
be tenant-wide while every operation still requires selected-Legal-Entity module authorization,
and ordinary edits must not delete records or bypass Action/evidence/runtime boundaries.

## Solution Statement

Generate the three dedicated Customer Actions first, then adapt their generated schemas/transport
and bind manual handlers to a CRM-local scoped service. Add `crm.customers` with forced tenant RLS,
normalization and partial registration-number uniqueness. Generate the `customer-directory` module
API, implement bounded cursor list/detail reads and the already-generated Customer resource-detail
provider through `defineRead`, and map every expected failure end to end.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Customer fields, invariants, ownership, Actions, reads, and errors.
- `tickets.md` — corresponding ticket 3; blocked by tickets 1 and 2.
- `verticals/crm/src/db/schema.ts` — CRM typed schema catalog established by ticket 2.
- `verticals/crm/drizzle.config.ts` — CRM migration owner configuration.
- `verticals/crm/vertical.manifest.ts` — generated Actions/API/resource descriptor publication.
- `verticals/crm/vertical.registration.ts` — private handler/read/provider binding.
- `docs/architecture/ACTIONS.md` — mutation lifecycle, events, evidence, idempotency, and rollback.
- `docs/architecture/DATA_ACCESS.md` — required Legal Entity scope with tenant-only RLS and scoped services.
- `docs/architecture/ERRORS.md` — typed public errors and generated client contract.
- `packages/core-runtime/src/reads/definition.ts` — governed read descriptor pattern.

### New Files

- `verticals/crm/src/customers/customer-repository.ts` — transaction-scoped typed Drizzle access.
- `verticals/crm/src/customers/customer-service.ts` — normalization, invariants, mutations, and read models.
- `verticals/crm/src/actions/create-customer.handler.ts` — manual private Create handler.
- `verticals/crm/src/actions/edit-customer.handler.ts` — manual private Edit handler.
- `verticals/crm/src/actions/delete-customer.handler.ts` — manual private Delete handler.
- `verticals/crm/tests/unit/customer-*.test.ts` — schema/service/Action/error tests.
- `verticals/crm/tests/integration/customer-*.test.ts` — PostgreSQL/RLS/runtime/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Generate the Customer Actions and customer-directory API, then define normalized schemas, typed
errors, resource/detail/list contracts, table/index/RLS, and migration before implementation.

### Phase 2: Core Implementation

Implement the scoped repository/service and manual handlers. Keep tenant/legal-entity values out of
business payloads; use optimistic versions and soft deletion; emit create/delete Domain Events and
record contributing reads as evidence.

### Phase 3: Integration

Bind handlers and read/provider implementations owner-locally, publish only safe descriptors,
exercise the generated Effect clients over strict BFF contracts, and prove selected-Legal-Entity
authorization plus tenant-wide row sharing.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate Customer business entrypoints

- [x] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action create-customer --legal-entity-scope required`, then repeat for `edit-customer` and `delete-customer`; do not create or generate handlers outside the approved binding point.
- [x] Run `mise exec -- pnpm scaffold:module-api -- --vertical crm --name customer-directory` before adapting its generated contract/client/read/server wiring.
- [x] Confirm all generated descriptors are owned by `crm.core`, idempotency-required, write/read access-correct, and registered through the owner-local runtime.

### 2. Define Customer contracts, schema, migration, and RLS

- [x] Adapt generated schemas for required trimmed company `name`; optional normalized company registration number, tax identification number, email, phone, website; structured optional address fields; UUID ID; optimistic version; timestamps; and tombstone. Payloads contain no tenant/legal-entity IDs, status, or deletion field.
- [x] Add `crm.customers` to the typed Drizzle schema with a partial unique index on normalized non-null registration number per tenant for non-deleted rows; do not make name, tax number, email, phone, or website unique.
- [x] Enable and force tenant RLS using transaction-local `ontos.tenant_id`; do not require `ontos.legal_entity_id` in the table policy even though operation descriptors require selected Legal Entity context.
- [x] Run `mise exec -- pnpm --filter @app/crm db:generate`, inspect the generated SQL for schema, constraints, index, RLS, and journal behavior, and extend CRM schema verification tests.

### 3. Implement scoped repository/service and manual Action handlers

- [x] Implement a transaction-scoped repository/service using typed Drizzle references only; normalize optional values, distinguish absent/deleted rows safely, and return declared typed persistence/domain failures without exposing database diagnostics.
- [x] Manually author and owner-bind Create, Edit, and Delete Effect handlers. Create enforces active registration-number uniqueness; Edit requires expected version and cannot delete; Delete requires expected version, sets `deleted_at`, does not cascade, and leaves descendants/historical references for later tickets.
- [x] Declare stable domain errors/events in the generated Action descriptors. Map duplicate/stale conflicts to `409`, absent/deleted targets to safe `404`, semantic invalidity to `422`, permission denial to `403`, uncertainty to retryable `503`, structural invalidity to `400`, and caught defects to sanitized `500`.
- [x] Emit past-tense create/delete Domain Events, successful Action audit/data-access evidence, and no ordinary-edit timeline event; prove business/event/audit/evidence/invocation success commits atomically.

### 4. Implement governed list, direct detail, and resource detail

- [x] Adapt `customer-directory` to bounded cursor pagination with deterministic `(normalized name, id)` ordering and direct detail; exclude tombstones from ordinary reads and reject excess/unbounded input.
- [x] Implement the generated Customer resource-detail provider with the same owner-local service and safe view model. Require selected-Legal-Entity trusted context/module access even though storage is tenant-only.
- [x] Bind all reads through `defineRead` with module/resource permission targets, metadata-only evidence, typed context/auth/module/permission failures, and no executor or backend import in clients.

### 5. Add focused tests beside each behavior

- [x] Add unit tests for schema exactness, trimming/normalization, optional fields, address/country validation, duplicate-friendly fields, cursor ordering, error mapping, descriptor scope, and edit/delete payload separation.
- [x] Add PostgreSQL/RLS/Action/BFF tests for duplicate normalized registration numbers, optimistic conflicts, soft deletion, idempotent replay/hash conflict, permission denial/check unavailability, selected-Legal-Entity module gating, tenant sharing across permitted entities, cross-tenant isolation, rollback, evidence, 401 challenge, Problem Details status/body agreement, client decoding, and private bundle isolation.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Cover contract schemas, normalization, service invariants, cursor codec/order, Action descriptors,
typed error mapping, and safe Customer view models.

### Integration Tests

Use PostgreSQL and Core runtime fixtures for forced RLS, migration/index behavior, selected-context
authorization, full Action atomicity/idempotency, governed read evidence, strict BFF server/client,
and public/private surface isolation.

### Edge Cases

- Multiple Customers omit registration number or share name/email/phone/tax number.
- Registration numbers differ only by accepted formatting/case.
- A stale editor races deletion or another edit.
- One Customer is read from two authorized Legal Entity contexts without duplicating its row.
- A deleted Customer is absent from ordinary reads and cannot be mutated.

## Acceptance Criteria

- [x] Customer persists every agreed company field with canonical English contract names and tenant-wide ownership.
- [x] Non-deleted normalized registration numbers are unique per tenant only when present.
- [x] Create, Edit, and Delete are generated dedicated Actions bound to manual handlers; edit cannot delete.
- [x] Paginated list, direct detail, and generated resource detail use the generated Effect clients and exclude deleted rows.
- [x] Forced tenant RLS, selected-Legal-Entity module authorization, typed errors, atomic evidence/events, idempotency, and rollback tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Customer schema/service/contract unit tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run Customer PostgreSQL/RLS/Action/BFF integration tests.
- `mise exec -- pnpm db:generate` — verify deterministic CRM migration generation.
- `mise exec -- pnpm db:verify` — verify the live CRM table/index/RLS inventory.
- `mise exec -- pnpm database-access:check` — reject unscoped/cross-owner database access.
- `mise exec -- pnpm api:check` — validate strict Effect contracts and clients.
- `mise exec -- pnpm module-entrypoints:check` — validate generated Action/API/resource entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: ticket 1 and ticket 2 must both be complete.
- Customer is always a company and is never modeled or labeled as Party.
- No Contact, primary-contact, Deal, Offer, Activity, search, restore, merge, or deduplication behavior belongs in this leaf.
- No Policy or Outbox Message is required: v1 authorization uses module/resource/Action checks and Customer events are consumed inside the same CRM vertical.

## Implementation Evidence

- Generated all three Customer Actions and the `customer-directory` API with Codesmith before adapting them; generator regression coverage passes.
- Added the typed `crm.customers` table, deterministic migration, partial active-registration uniqueness, four tenant policies, and explicit forced RLS verification.
- Bound private scoped services and handlers owner-locally; create/delete events and contributing-read evidence are covered alongside the Core Action runtime's atomicity, idempotency, authorization, and rollback suites.
- Implemented bounded list, direct detail, and resource detail through generated Effect clients and strict typed Problem Details contracts.
- Passed CRM unit (17 tests), CRM PostgreSQL integration (2 tests), deterministic database generation/verification, API/database/module boundary checks, the complete `pnpm check` gate, and a clean-snapshot full production build.
