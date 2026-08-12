---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 15 Offer lifecycle backend

## Feature Description

Implement ticket 15, "Implement the Offer lifecycle backend," from `app/tickets.md`. Add the
dedicated `ChangeOfferStatus` Action as the only Offer status mutation, enforcing exactly the
approved transition graph, higher-revision superseding, at most one active Accepted Offer per Deal,
terminal states, generated Action-specific Effect transport/client, manual private handler, typed
errors, authorization/evidence/events, database constraints, and exhaustive concurrency/rollback tests.

## User Story

As an authorized CRM sales user
I want to explicitly send and resolve Offer revisions through valid statuses
So that proposal outcomes are consistent, auditable, and historically traceable

## Problem Statement

Offers start Draft but have no lifecycle mutation. The operation must reject forbidden transitions,
terminal changes, stale/deleted/cross-scope state, superseding without a higher active revision, and
concurrent multiple acceptance—without implicitly changing the Deal, another Offer, or Activity.

## Solution Statement

Generate one lifecycle Action, add a partial accepted uniqueness invariant if needed, define a pure
transition graph and safe Domain Event, and manually bind a row-locked scoped handler. Use existing
Offer schema/repository/service and generated transport; no separate API or generic status endpoint.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Offer transitions, terminal states, supersede, acceptance, and non-effects.
- `tickets.md` — corresponding ticket 15; blocked by ticket 13.
- `verticals/crm/src/db/schema.ts` — Offer status and accepted uniqueness invariant.
- `verticals/crm/src/offers/offer-repository.ts` — scoped locking/status update/revision lookup.
- `verticals/crm/src/offers/offer-service.ts` — transition and parent validation.
- `docs/architecture/ACTIONS.md` and `docs/architecture/ERRORS.md` — lifecycle Action/error/event behavior.

### New Files

- `verticals/crm/src/actions/change-offer-status.handler.ts` — manual owner-local lifecycle handler.
- `verticals/crm/tests/unit/offer-lifecycle-*.test.ts` — graph/schema/error tests.
- `verticals/crm/tests/integration/offer-lifecycle-*.test.ts` — concurrency/RLS/Action/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Generate the Action, define exact transition/error/event contracts, and add/verify the accepted
Offer database uniqueness invariant through typed schema/migration.

### Phase 2: Core Implementation

Implement row-locked service/handler for the approved transitions, higher-revision superseding,
terminal behavior, and single acceptance with no implicit other-entity changes.

### Phase 3: Integration

Bind owner-locally, map complete errors through generated transport/client, and prove every
allowed/forbidden transition, concurrency, idempotency, RLS, evidence/event atomicity, and rollback.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the Offer lifecycle Action

- [ ] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action change-offer-status --legal-entity-scope required` before writing the handler.
- [ ] Adapt schemas for Offer ID, expected version/current-state protection, target status enum, updated version, and no trusted scope/free-text status fields.

### 2. Define transition and database invariants

- [ ] Implement a pure transition function permitting only `Draft -> Sent|Withdrawn` and `Sent -> Accepted|Rejected|Withdrawn|Superseded`; Accepted, Rejected, Withdrawn, and Superseded have no outgoing transitions and no-op is rejected.
- [ ] Add a partial unique index enforcing at most one non-deleted Accepted Offer per tenant/legal-entity/Deal; generate/inspect the Drizzle migration and map uniqueness races to a declared `409`.
- [ ] Define superseding validation requiring a higher active revision of the same Deal/scope; do not mutate the higher revision or auto-supersede anything.
- [ ] Declare a safe past-tense status event with Offer/Deal/Customer references and previous/new status for the Customer timeline.

### 3. Implement scoped service and manual handler

- [ ] Lock the target Deal and relevant active Offers deterministically through scoped repository/RLS, validate expected version/current status/parent/higher revision, update exactly one Offer, and record event/evidence atomically.
- [ ] Return typed semantic `422` for forbidden/terminal/supersede-ineligible transitions and `409` for stale/current-state or competing acceptance/revision conflicts, plus declared `400/401/403/404/503/500` outcomes.
- [ ] Perform no Deal status update, no other Offer status change, no Activity creation, no external communication, and no hidden automation.
- [ ] Bind owner-locally and keep handler/repository out of manifest/browser exports.

### 4. Add exhaustive tests

- [ ] Unit-test every allowed/forbidden status pair, terminal/no-op behavior, higher-revision rule, event payload, schemas, descriptor, and typed mappings.
- [ ] Add concurrent PostgreSQL/RLS/Action/BFF tests for two acceptances, supersede with/without higher active revision, stale/deleted/cross-scope state, idempotent replay/hash conflict, permission denial/check unavailable, selected-context isolation, database uniqueness, no implicit writes, event/audit/data-access/invocation atomicity, rollback, and generated client decoding.
- [ ] Retain regression tests proving Create/Edit/Delete Offer cannot mutate status and only Draft is editable.

### 5. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Table-test full status graph, terminal/no-op/supersede logic, schemas/events, descriptor, and error
mapping.

### Integration Tests

Use concurrent PostgreSQL/Core runtime/strict BFF calls for accepted uniqueness, locks, RLS,
idempotency, authorization, generated client, event/evidence atomicity, and no implicit writes.

### Edge Cases

- Two Sent revisions are accepted concurrently.
- Offer is superseded without a higher active revision or with one in another scope.
- Target is current or source is terminal.
- Offer/Deal is deleted or cross-entity.
- Commit/evidence persistence becomes indeterminate.

## Acceptance Criteria

- [ ] `ChangeOfferStatus` is the only status mutation and enforces exactly the approved graph/terminal states.
- [ ] Superseding requires a higher active revision and only one active Accepted Offer exists per Deal.
- [ ] Exactly one Offer changes; no Deal/other Offer/Activity/external side effect occurs.
- [ ] Exhaustive transition, concurrency, RLS, authorization, idempotency, event/evidence, BFF, and rollback tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Offer lifecycle graph/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run concurrent Offer lifecycle Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic accepted-Offer constraint migration.
- `mise exec -- pnpm db:verify` — verify accepted uniqueness/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped lifecycle access.
- `mise exec -- pnpm api:check` — validate generated lifecycle transport/client.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 13 must be complete.
- No Deal mutation, Offer auto-superseding, Activity, communication, Policy, or Outbox Message belongs here.
