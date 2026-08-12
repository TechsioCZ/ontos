---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 17 Activity backend

## Feature Description

Implement ticket 17, "Implement the Activity backend," from `app/tickets.md`. Add the complete
Legal-Entity-owned Activity backend for historical Note, Call, Email, Meeting, and Other records:
typed schema/migration/forced RLS, scoped repository/service, generated Create/Edit/Delete Actions
and Action-specific clients, manual private Effect handlers, generated Activity list/detail BFF
reads supporting the later timeline, typed errors, authorization/evidence, and tests. Activities
record completed interactions only and perform no external communication or scheduling.

## User Story

As an authorized CRM user
I want to record historical interactions with a Customer
So that relationship context is available without implying OntOS performed the communication

## Problem Statement

CRM has no explicit interaction record. Activity must belong to a shared Customer and selected
Legal Entity, optionally reference a same-Customer Contact and same-Customer/same-entity Deal,
default occurrence time on the server, remain editable/deletable through dedicated Actions, and
never send email, place calls, schedule meetings, or mutate commercial entities.

## Solution Statement

Generate three Actions and the `activity-timeline` module API. Add `crm.activities` with fixed type,
cross-field composite constraints, forced tenant/legal-entity RLS, and scoped services/manual
handlers. Implement bounded Activity reads and safe historical labels that ticket 18 can merge with
Core lifecycle Domain Events.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Activity fields/types/scope/non-effects and timeline role.
- `tickets.md` — corresponding ticket 17; blocked by tickets 5 and 9.
- `verticals/crm/src/db/schema.ts` — Customer/Contact/Deal scope definitions.
- `verticals/crm/src/contacts/contact-service.ts` and `verticals/crm/src/deals/deal-service.ts` — active reference validation.
- `verticals/crm/vertical.manifest.ts` and `verticals/crm/vertical.registration.ts` — generated Action/API publication/private binding.
- `docs/architecture/ACTIONS.md`, `DATABASE.md`, `DATA_ACCESS.md`, and `ERRORS.md` — full backend path rules.

### New Files

- `verticals/crm/src/activities/activity-repository.ts` — scoped typed Activity persistence/read access.
- `verticals/crm/src/activities/activity-service.ts` — type/reference/time/mutation/read behavior.
- `verticals/crm/src/actions/create-activity.handler.ts` — manual private Create handler.
- `verticals/crm/src/actions/edit-activity.handler.ts` — manual private Edit handler.
- `verticals/crm/src/actions/delete-activity.handler.ts` — manual private Delete handler.
- `verticals/crm/tests/unit/activity-*.test.ts` — schemas/services/contracts/errors.
- `verticals/crm/tests/integration/activity-*.test.ts` — PostgreSQL/RLS/Action/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Generate Activity Actions/API, define exact schemas/errors, and add Activity table, composite
reference constraints/indexes, forced RLS, and generated migration.

### Phase 2: Core Implementation

Implement scoped repository/service and manual handlers with server-default occurrence time,
optional links validated to the same Customer/scope, optimistic edit/delete, and no external side effects.

### Phase 3: Integration

Implement bounded list/detail reads and safe labels, bind strict generated transports/client,
authorize selected scope, and prove every type/link combination, RLS, atomicity, and non-effects.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate Activity business entrypoints

- [ ] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action create-activity --legal-entity-scope required`, then repeat for `edit-activity` and `delete-activity`.
- [ ] Run `mise exec -- pnpm scaffold:module-api -- --vertical crm --name activity-timeline` before adapting its generated contract/client/read/server wiring.
- [ ] Verify `crm.core` ownership, required idempotency/scope, generated Action-specific transport, and no generated private handler.

### 2. Define Activity contracts, schema, migration, and RLS

- [ ] Adapt schemas for Customer ID, fixed type Note/Call/Email/Meeting/Other, required trimmed subject, optional details, optional occurrence time input with server current-time default, optional Contact ID, optional Deal ID, expected version, timestamps, and tombstone. Exclude trusted scope/deletion fields.
- [ ] Add `crm.activities` with UUID, tenant/legal-entity/Customer and optional Contact/Deal composite FKs, type check, required occurrence timestamp, version/timestamps/tombstone, and deterministic Customer/time indexes.
- [ ] Protect same-tenant Customer/Contact and same-tenant/same-Legal-Entity/same-Customer Deal relationships at database level where expressible; add service checks for remaining cross-field semantics and no cascading history deletion.
- [ ] Enable and force tenant plus legal-entity RLS; generate/inspect the migration and extend exact schema/FK/check/index/RLS verification tests.

### 3. Implement scoped repository/service and manual handlers

- [ ] Implement typed Drizzle repository/service from the Core-supplied transaction, deriving tenant/legal entity/server default time from trusted runtime only.
- [ ] Create validates active Customer and optional active same-Customer Contact/Deal; Edit can change type/subject/details/occurrence time/optional links with expected version but not Customer ownership/deletion; Delete tombstones only the Activity.
- [ ] Return typed structural/auth/permission/not-found/conflict/semantic/unavailable/internal outcomes with correct `400/401/403/404/409/422/503/500` Problem Details/client unions.
- [ ] Record Action audit/data-access evidence and rollback atomically. Activity rows themselves are the relationship-history source; do not manufacture a second Activity event solely for the timeline.
- [ ] Perform and test no email send, call placement, meeting scheduling, Deal/Offer mutation, implicit Activity, or other external effect.

### 4. Implement governed Activity reads

- [ ] Adapt `activity-timeline` with bounded deterministic active Activity list/detail for one Customer ordered by occurrence time and ID, plus safe Contact/Deal labels and cursor schema needed by ticket 18.
- [ ] Require Customer resource/module permission and selected-Legal-Entity scope, filter all commercial links through forced RLS, exclude deleted ordinary records, and retain safe historical labels where explicitly requested.
- [ ] Preserve metadata-only evidence, typed generated Effect client errors, and private server/repository isolation.

### 5. Add focused tests beside behavior

- [ ] Unit-test every Activity type, server/default versus explicit occurrence time, optional-link combinations, cross-field validation, editable-field separation, cursor order, schemas/descriptors/errors, and no-effect service surface.
- [ ] Add PostgreSQL/RLS/Action/BFF tests for cross-Customer Contact/Deal, cross-Legal-Entity Deal, deleted references, trusted scope/time, optimistic conflict, idempotent replay/hash conflict, selected-context isolation, permission denial/check unavailable, soft delete/no cascade, rollback/evidence atomicity, all declared statuses, generated client decoding, private bundle isolation, and zero external/cross-entity calls.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Cover exact schemas/types, time/reference validation, service decisions, cursor ordering, Action
descriptors/errors, historical labels, and absence of external side-effect capabilities.

### Integration Tests

Use PostgreSQL/Core runtime/strict BFF fixtures for composite constraints, forced RLS, Actions,
idempotency/evidence, authorization, generated client, isolation, and zero implicit writes/effects.

### Edge Cases

- Every combination of optional Contact and Deal.
- Contact/Deal belongs to another Customer or Deal to another Legal Entity.
- Occurrence time omitted, explicit, future, or around ordering ties according to contract bounds.
- Linked/deleted parent changes during edit.
- Activity edit/delete races another mutation.

## Acceptance Criteria

- [ ] Activity stores the agreed types/fields/links/scope/version/tombstone with server-default occurrence time.
- [ ] Generated Create/Edit/Delete Actions bind manual handlers and validate same-Customer/same-scope references.
- [ ] Typed reads support the timeline backend while ordinary results exclude deleted rows.
- [ ] No external communication/scheduling or implicit entity mutation occurs.
- [ ] Type/link/time/RLS/idempotency/concurrency/authorization/atomicity/BFF tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Activity schema/service/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run Activity PostgreSQL/RLS/Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic Activity migration.
- `mise exec -- pnpm db:verify` — verify Activity FK/check/index/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped Activity access.
- `mise exec -- pnpm api:check` — validate generated Effect transports/clients.
- `mise exec -- pnpm module-entrypoints:check` — validate Activity Action/API entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 5 and 9 must both be complete.
- Ticket 18 owns mixed timeline composition; ticket 19 owns Activity/timeline UI.
- No external email/call/calendar, search, Policy, or Outbox Message belongs here.
