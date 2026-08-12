---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 11 Deal lifecycle backend

## Feature Description

Implement ticket 11, "Implement the Deal lifecycle backend," from `app/tickets.md`. Add the dedicated
`ChangeDealStatus` Action as the only Deal status mutation, supporting every transition among New,
Qualified, Offer sent, Negotiation, Won, and Lost—including reopening—through generated
Action-specific transport/client, a manual private Effect handler, typed errors, authorization,
Domain Events/evidence, and exhaustive status-pair/concurrency/rollback tests.

## User Story

As an authorized CRM sales user
I want to explicitly move or reopen a Deal between fixed statuses
So that commercial progress is audited and visible in relationship history

## Problem Statement

Deals always start New and ordinary edit cannot change status. CRM needs a concurrency-safe,
audited lifecycle operation whose events later feed the Customer timeline without configurable
pipeline rules or hidden side effects.

## Solution Statement

Generate one Action, define exact current/target/version and event contracts, and manually bind a
handler that locks the selected-Legal-Entity Deal, rejects no-op/stale/deleted/cross-scope requests,
allows all distinct target statuses, and atomically updates version/status plus safe lifecycle event
and evidence. No schema table beyond the existing status column is required.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative statuses, all-to-all transition rule, reopening, and timeline event.
- `tickets.md` — corresponding ticket 11; blocked by ticket 9.
- `verticals/crm/src/db/schema.ts` — existing Deal status/version/RLS definition.
- `verticals/crm/src/deals/deal-repository.ts` — scoped locking/status update.
- `verticals/crm/src/deals/deal-service.ts` — lifecycle validation and event data.
- `docs/architecture/ACTIONS.md` — lifecycle Action/event/evidence/transaction rules.
- `docs/architecture/ERRORS.md` — no-op/state conflict and unavailable transport semantics.

### New Files

- `verticals/crm/src/actions/change-deal-status.handler.ts` — manual owner-local lifecycle handler.
- `verticals/crm/tests/unit/deal-lifecycle-*.test.ts` — transition/schema/error tests.
- `verticals/crm/tests/integration/deal-lifecycle-*.test.ts` — concurrent Action/event/RLS tests.

## Implementation Plan

### Phase 1: Foundation

Generate the Action and define all fixed status schemas, expected versions, declared failures, and
safe previous/new status Domain Event.

### Phase 2: Core Implementation

Implement row-locked lifecycle service/handler using the existing Deal table and forced RLS. Allow
every distinct status pair; reject no-op, stale, deleted, or cross-scope requests.

### Phase 3: Integration

Bind owner-locally, expose generated transport/client, and prove authorization, all pairs,
idempotency, event/audit/evidence atomicity, timeline-safe data, and rollback.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the lifecycle Action

- [ ] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action change-deal-status --legal-entity-scope required` before writing the handler.
- [ ] Adapt payload/result/error schemas for Deal ID, expected version/current state protection, target status enum, updated version, and no tenant/legal-entity/status-free-text fields.

### 2. Define lifecycle and event contracts

- [ ] Implement a pure transition function covering all 30 distinct ordered status pairs and rejecting six no-op pairs; there is no configurable pipeline or terminal Deal status.
- [ ] Declare stable failures for invalid/no-op semantic request, absent/deleted Deal, stale/current-state conflict, permission/check, persistence/evidence uncertainty, and caught defect with correct public statuses.
- [ ] Declare a past-tense Deal-status Domain Event containing only safe Deal/Customer references, previous status, new status, occurrence time/correlation supplied by runtime—not values, descriptions, or private diagnostics.

### 3. Implement scoped service and manual handler

- [ ] Lock and load the active Deal through the scoped repository/RLS, validate expected version, update status/version/timestamp once, and add the declared event/read evidence in the Core-owned transaction.
- [ ] Permit reopening Won/Lost to any other status and transitions into Won/Lost from any other status; perform no Offer/Activity mutation and no implicit automation.
- [ ] Bind the handler owner-locally and exhaustively map generated endpoint/client outcomes: `400`, `401`, `403`, `404`, `409`, `422`, `503`, and sanitized `500`.

### 4. Add exhaustive tests

- [ ] Unit-test every source/target pair, no-op behavior, schema exactness, event payload, descriptor ownership/scope, and error mappings.
- [ ] Add PostgreSQL/RLS/Action/BFF tests for Won/Lost reopening, two concurrent transitions, stale version, deleted/cross-entity Deal, idempotent replay/hash conflict, permission denial/check unavailability, selected-context isolation, event/audit/data-access/invocation atomicity, rollback, generated client decoding, and no ordinary EditDeal status capability.

### 5. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Use a table-driven matrix for all 36 status pairs, plus exact schemas, event data, Action descriptor,
and exhaustive typed error mapping.

### Integration Tests

Execute concurrent generated Action calls against PostgreSQL/Core runtime to prove RLS, optimistic
conflict, idempotency, authorization, strict BFF client/server, event/evidence atomicity, and rollback.

### Edge Cases

- Won/Lost Deal is reopened directly to any other status.
- Target equals current status.
- Two callers transition from the same version.
- Deal is soft-deleted or in another Legal Entity.
- Database commits are uncertain during event/evidence persistence.

## Acceptance Criteria

- [ ] `ChangeDealStatus` is the only Deal status mutation and supports every distinct fixed-status pair.
- [ ] Reopening, no-op/stale/deleted/cross-scope outcomes are declared and correct.
- [ ] Successful transitions publish exactly one safe previous/new status event atomically.
- [ ] Exhaustive pair, idempotency, concurrency, authorization, RLS, BFF, evidence, and rollback tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Deal lifecycle matrix/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run lifecycle PostgreSQL/Action/BFF tests.
- `mise exec -- pnpm database-access:check` — validate scoped lifecycle persistence.
- `mise exec -- pnpm api:check` — validate generated lifecycle transport/client.
- `mise exec -- pnpm action:test:unit` — retain Core Action lifecycle behavior.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 9 must be complete.
- No schema migration is expected unless typed enum/check representation requires a generated change; do not handwrite one.
- No configurable pipeline, implicit Offer/Activity behavior, Policy, or Outbox Message belongs here.
