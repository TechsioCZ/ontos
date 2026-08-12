---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 13 Offer revision backend

## Feature Description

Implement ticket 13, "Implement the Offer revision backend," from `app/tickets.md`. Add the complete
Deal-scoped, Legal-Entity-owned Offer revision backend: typed schema/migration/forced RLS,
concurrency-safe revision allocation, scoped repository/service, generated Create/Edit/Delete
Actions and Action-specific clients, manually authored private Effect handlers, deterministic
revision list/detail BFF reads, typed errors, authorization/evidence/events, and tests. Lifecycle
status changes remain outside this leaf.

## User Story

As an authorized CRM sales user
I want immutable numbered Offer revisions under a Deal
So that changing commercial terms creates traceable proposals instead of overwriting history

## Problem Statement

Deals have no commercial proposals. Offers must allocate revisions atomically, always start Draft,
permit ordinary editing only while active Draft, preserve immutable revision/status boundaries,
isolate selected Legal Entity, and never implicitly mutate the Deal, another Offer, or Activity.

## Solution Statement

Generate Create/Edit/Delete Offer Actions, add `crm.offers` with composite Deal scope constraints,
revision uniqueness, fixed statuses, money/currency checks, and forced RLS. Implement manual handlers
over a scoped service, extend the generated `deal-workspace` API with deterministic revision list
and detail, and publish a safe Offer-created event for the future Customer timeline.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Offer fields, revision, Draft edit, deletion, and event rules.
- `tickets.md` — corresponding ticket 13; blocked by ticket 9.
- `verticals/crm/src/db/schema.ts` — existing Deal scope and CRM catalog.
- `verticals/crm/src/deals/deal-service.ts` — active Deal validation/safe labels.
- `verticals/crm/shared/apis/deal-workspace.ts` — generated read contract to extend.
- `verticals/crm/src/api/deal-workspace-client.ts` — generated Effect read client.
- `verticals/crm/vertical.manifest.ts` and `verticals/crm/vertical.registration.ts` — Action/API publication/private binding.
- `docs/architecture/ACTIONS.md`, `DATABASE.md`, `DATA_ACCESS.md`, and `ERRORS.md` — complete backend path rules.

### New Files

- `verticals/crm/src/offers/offer-repository.ts` — scoped revision locking/persistence/read access.
- `verticals/crm/src/offers/offer-service.ts` — revision, Draft, money, parent, and read behavior.
- `verticals/crm/src/actions/create-offer.handler.ts` — manual private Create handler.
- `verticals/crm/src/actions/edit-offer.handler.ts` — manual private Edit handler.
- `verticals/crm/src/actions/delete-offer.handler.ts` — manual private Delete handler.
- `verticals/crm/tests/unit/offer-revision-*.test.ts` — schema/service/contract tests.
- `verticals/crm/tests/integration/offer-revision-*.test.ts` — PostgreSQL/RLS/Action/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Generate Actions, define exact schemas/errors/events, and add Offer table, composite constraints,
revision indexes, forced RLS, and generated migration.

### Phase 2: Core Implementation

Implement scoped repository/service and manual handlers with row-locked revision allocation, Draft
only edit, optimistic delete, no cascade, and no implicit cross-entity mutation.

### Phase 3: Integration

Extend deal-workspace list/detail contracts, bind generated transports/read implementations, and
prove revision races, isolation, typed errors, authorization, atomicity, and private boundaries.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate dedicated Offer revision Actions

- [ ] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action create-offer --legal-entity-scope required`, then repeat for `edit-offer` and `delete-offer`.
- [ ] Confirm `crm.core` ownership, idempotency-required descriptors, generated Action-specific transport/client, and no generated handler/generic mutation endpoint.

### 2. Define Offer contracts, schema, migration, and RLS

- [ ] Adapt generated schemas for Deal ID, immutable positive revision output, title, optional description, required non-negative amount, uppercase ISO 4217 currency, optional validity date, fixed status output, expected version, timestamps, and tombstone. Exclude revision/status/deletion/trusted scope from create/edit input.
- [ ] Add `crm.offers` with UUID, tenant/legal-entity/Deal composite FKs, positive revision, unique active `(tenant_id, legal_entity_id, deal_id, revision_number)`, initial `Draft`, money/currency/date checks, version/timestamps/tombstone, and deterministic revision indexes.
- [ ] Add database protection for same-tenant/same-Legal-Entity Deal and no cascade erasure. Enable and force tenant plus legal-entity RLS.
- [ ] Generate/inspect the migration and extend exact schema/FK/index/check/RLS verification tests.

### 3. Implement scoped repository/service and manual handlers

- [ ] Implement typed Drizzle methods that lock the active Deal/revision allocation scope and compute the next positive revision without a race; no global pool/executor or payload scope.
- [ ] Create always allocates next revision and Draft; Edit requires active Draft and expected version and changes only title/description/amount/currency/validity; Delete requires expected version and tombstones only the target Offer.
- [ ] Reject deleted/cross-scope Deal/Offer, non-Draft edit, stale version, malformed money/currency/date, and revision races as declared errors. Do not mutate Deal status, another Offer, or Activity.
- [ ] Emit a declared safe Offer-created Domain Event for timeline use and appropriate delete/audit evidence without routine-edit timeline facts; prove Action/business/event/evidence atomicity and rollback.
- [ ] Map `400/401/403/404/409/422/503/500` exhaustively through generated Problem Details/client unions.

### 4. Implement governed revision reads

- [ ] Extend `deal-workspace` with bounded cursor Offer list for one active Deal ordered deterministically by revision number descending then ID, plus direct Offer detail. Exclude tombstones from ordinary reads and preserve safe historical labels.
- [ ] Require selected-Legal-Entity module/Deal authorization and metadata-only evidence. Offer remains an addressable CRM child, not a public cross-module ResourceRef/provider.
- [ ] Keep generated client Effects typed and server/repository/handler code absent from browser exports.

### 5. Add focused tests beside behavior

- [ ] Add unit tests for schema exactness, revision immutability/allocation decisions, Draft-only edit, money/currency/date validation, deterministic ordering, parent state, descriptors/events, and error mapping.
- [ ] Add concurrent PostgreSQL/RLS/Action/BFF tests for revision allocation races, deleted/cross-entity Deal, non-Draft edit, optimistic conflicts, idempotent replay/hash conflict, selected-context isolation, authorization denial/check unavailable, no cascade/implicit mutations, rollback/evidence/event atomicity, all declared statuses, client decoding, and private bundle isolation.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Cover exact schemas, revision and Draft rules, money/date/currency, service decisions, read ordering,
Action descriptors/events, typed errors, and safe Offer view models.

### Integration Tests

Use concurrent PostgreSQL/Core runtime/strict BFF fixtures for allocation, composite FKs, forced
RLS, Actions/evidence/idempotency, authorization, generated client, and no implicit writes.

### Edge Cases

- Two Offer revisions are created concurrently.
- A Sent/terminal or deleted Offer is edited.
- Parent Deal is deleted or in another Legal Entity.
- Amount/currency/date is invalid.
- Edit/delete races another mutation.

## Acceptance Criteria

- [ ] Offers have immutable positive Deal revisions, selected-scope ownership, initial Draft, agreed fields/version/tombstone.
- [ ] Generated Create/Edit/Delete Actions bind manual handlers; only active Draft is editable and no implicit entity mutation occurs.
- [ ] Revision list/detail are deterministic, typed, authorized, and selected-Legal-Entity isolated.
- [ ] Revision race, RLS, idempotency, concurrency, authorization, rollback/evidence/event, and BFF tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Offer revision schema/service/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run Offer revision PostgreSQL/RLS/Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic Offer migration.
- `mise exec -- pnpm db:verify` — verify Offer FK/index/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped Offer persistence.
- `mise exec -- pnpm api:check` — validate generated Effect transports/clients.
- `mise exec -- pnpm module-entrypoints:check` — validate Offer Action/API entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 9 must be complete.
- Ticket 15 exclusively owns Offer lifecycle transitions/accepted uniqueness; ticket 14 owns UI.
- No line items, products, files/PDFs, sending, public Offer ResourceRef, Policy, or Outbox Message belongs here.
