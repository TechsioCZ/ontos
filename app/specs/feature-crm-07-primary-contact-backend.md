---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 07 Primary Contact backend

## Feature Description

Implement ticket 7, "Implement the primary Contact backend," from `app/tickets.md`. Add one dedicated
`ChangeCustomerPrimaryContact` Action that atomically sets, replaces, or explicitly clears a
Customer's primary Contact, supported by a database uniqueness invariant, complete generated
Action-specific Effect transport/client, a manually authored private handler, typed errors,
authorization/evidence/event behavior, and concurrency/rollback tests.

## User Story

As an authorized CRM user
I want to designate or clear one primary Contact for a Customer
So that the preferred person is explicit and consistent under concurrent changes

## Problem Statement

Contacts store a default-false primary flag but no safe mutation path. Updating two rows through
ordinary edit would allow races, partial state, or multiple primaries. The operation must be one
atomic Action with expected-version protection and no backdoor through Contact edit.

## Solution Statement

Generate the dedicated Action, add a partial unique database index for one active primary per
Customer, then implement a scoped repository/service transaction that validates Customer/contact
ownership, clears the prior primary, sets the requested active Contact or clears all, and emits one
declared business event. Expose only the generated Action client/endpoint.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative primary-contact intent, concurrency, and event rules.
- `tickets.md` — corresponding ticket 7; blocked by ticket 5.
- `verticals/crm/src/db/schema.ts` — Contact table and new partial uniqueness invariant.
- `verticals/crm/src/contacts/contact-repository.ts` — scoped row locking/update operations.
- `verticals/crm/src/contacts/contact-service.ts` — Customer/contact validation and atomic change behavior.
- `verticals/crm/vertical.manifest.ts` and `verticals/crm/vertical.registration.ts` — generated descriptor and private binding.
- `docs/architecture/ACTIONS.md` — one intent, transaction, event, evidence, and idempotency rules.
- `docs/architecture/ERRORS.md` — typed conflict/not-found/semantic/authorization transport.

### New Files

- `verticals/crm/src/actions/change-customer-primary-contact.handler.ts` — manual owner-local Effect handler.
- `verticals/crm/tests/unit/primary-contact-*.test.ts` — contract/service/error tests.
- `verticals/crm/tests/integration/primary-contact-*.test.ts` — uniqueness/concurrency/Action tests.

## Implementation Plan

### Phase 1: Foundation

Generate the Action and define exact payload/result/error/event contracts plus the database unique
invariant and migration.

### Phase 2: Core Implementation

Implement row-locked scoped service behavior and the manual handler for set/replace/clear, using
trusted scope and expected versions only.

### Phase 3: Integration

Bind the handler owner-locally, map complete runtime/domain failures through generated BFF transport,
and test races, replays, authorization, RLS, event/evidence atomicity, and rollback.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the dedicated Action

- [x] Run `mise exec -- pnpm scaffold:action -- --vertical crm --action change-customer-primary-contact --legal-entity-scope required` before authoring the handler.
- [x] Adapt the generated contract to accept Customer ID, nullable selected Contact ID for explicit clear, expected Customer/current-primary/selected-Contact versions needed for concurrency, and no trusted scope fields.

### 2. Add the database invariant and repository operations

- [x] Add a partial unique index allowing at most one non-deleted `is_primary_contact = true` Contact per `(tenant_id, customer_id)` and generate/inspect the Drizzle migration.
- [x] Add typed repository methods that lock the Customer and relevant active Contact rows in deterministic order, read the current primary, and update clear/set state inside the Core-owned transaction without exposing an executor.
- [x] Map the unique-index race and stale expected versions to the stable declared `409` conflict rather than a raw database error.

### 3. Implement and bind the manual Effect handler

- [x] Validate active same-tenant Customer, selected active Contact ownership, current/selected versions, and explicit clear semantics. A foreign/deleted Contact must never be selected.
- [x] Atomically clear the previous primary and set the selected Contact, or clear all when requested; never call ordinary Contact edit handlers and never persist an intermediate committed state.
- [x] Emit one declared past-tense event with safe Customer/previous/new Contact references and record contributing reads/evidence. Idempotent replay must not rerun or duplicate the event.
- [x] Exhaustively map structural `400`, auth `401`, permission `403`, absent `404`, stale/competing `409`, semantic `422`, unavailable `503`, and sanitized `500` through the generated endpoint/client.

### 4. Add focused tests beside behavior

- [x] Add unit tests for set/replace/clear decisions, payload exactness, version requirements, owner checks, event payload, and typed mapping.
- [x] Add PostgreSQL/RLS/Action/BFF tests for uniqueness, two competing primary changes, clear versus set race, deleted/foreign Contact, stale Customer/contact versions, idempotent replay/hash conflict, permission denial/check failure, selected-context authorization, rollback, audit/event/data-access atomicity, and generated client decoding.
- [x] Retain regression tests proving Create/Edit/Delete Contact payloads and services cannot mutate `is_primary_contact`.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test exact schemas, set/replace/clear transition logic, version/ownership validation, event data, and
error mapping.

### Integration Tests

Use concurrent PostgreSQL Action execution to prove row locks plus unique index enforce one primary,
and verify RLS, authorization, idempotency, generated transport/client, evidence, and rollback.

### Edge Cases

- Two requests choose different Contacts concurrently.
- Clear races a replacement.
- Selected Contact is deleted after the UI loaded.
- Current primary is already the requested Contact with matching or stale version.
- Customer or selected Contact belongs to another tenant.

## Acceptance Criteria

- [x] `ChangeCustomerPrimaryContact` is the only primary mutation and is generated/bound correctly.
- [x] Set, replace, and explicit clear are one atomic transaction with at most one active primary.
- [x] Foreign/deleted Contacts and stale/competing writes return declared outcomes without partial changes.
- [x] Event, evidence, authorization, idempotency, RLS, uniqueness, concurrency, and rollback tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run primary-contact service/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run concurrent PostgreSQL/Action/BFF tests.
- `mise exec -- pnpm db:generate` — verify deterministic primary uniqueness migration.
- `mise exec -- pnpm db:verify` — verify index/RLS inventory.
- `mise exec -- pnpm database-access:check` — validate scoped repository access.
- `mise exec -- pnpm api:check` — validate generated Action transport/client.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 5 must be complete.
- No UI, Contact reassignment, automatic primary selection, Policy, Outbox Message, or cross-module behavior belongs here.

## Implementation Evidence

### Summary

- Generated and bound `crm.core.change-customer-primary-contact`, then adapted its exact scope-free payload/result/error/event contracts and generated Effect BFF server/client.
- Added the partial active-primary uniqueness invariant and one Core-owned transaction that locks the Customer before deterministically locked Contact candidates, validates expected versions and ownership, and atomically sets, replaces, or clears the designation.
- Added typed `400`/`401`/`403`/`404`/`409`/`422`/`428`/`500`/`503` transport mapping, safe event/data-access evidence, idempotent replay behavior, and regression protection for ordinary Contact mutations.

### Changed Files and Diff Stat

- `verticals/crm/src/actions/**`, `shared/apis/**`, `api/**`, and `src/api/**`: generated contract/registration/transport/client plus the manual private handler.
- `verticals/crm/src/{contacts,customers,db}/**` and `drizzle/**`: scoped compound behavior, repository locking/version updates, typed race mapping, schema invariant, migration, and schema verification.
- `verticals/crm/tests/**`, manifest, registration, and API composition: unit, PostgreSQL/RLS/concurrency, live Action lifecycle, authorization, rollback, BFF, client, and publication coverage.
- `specs/feature-crm-07-primary-contact-backend.md`: implementation status and evidence.
- Diff stat at completion: 29 files changed, approximately 3,324 insertions and 5 deletions before this evidence section.

### Tests and Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — PASS, 32 Node tests and 32 Rstest tests.
- `mise exec -- pnpm --filter @app/crm test:integration` against the isolated local PostgreSQL/SpiceDB fixtures — PASS, 7/7.
- `mise exec -- pnpm db:generate` with isolated database configuration — PASS; Core, Auth, and CRM reported no schema changes after the checked-in migration.
- `mise exec -- pnpm db:verify` against the isolated database — PASS; Core 18, Auth 6, and CRM 2 typed tables verified.
- `mise exec -- pnpm database-access:check` — PASS.
- `mise exec -- pnpm api:check` — PASS.
- `mise exec -- pnpm check` — PASS, including formatting, lint, type checking, Action tests, entrypoint/module contracts, API/database boundaries, and workspace validation.
- `GIT_DIR=/tmp/codex-ontos-crm07-build-no-git ULTRAMODERN_SOURCE_REVISION=6be91cd14679621dcc2d6572f0aa8b416ec275e6 mise exec -- pnpm build` — PASS, including CRM/Shell production compilation, public module artifacts, deploy packaging, Module Federation types, and performance readiness.

### Review Evidence

- Reviewed the complete working-tree diff against this specification, both `AGENTS.md` files, and the referenced MicroVertical, Action, error, UltraModern, database, governed-data-access, module-entrypoint, and module-manifest guidance.
- Spec review: PASS after adding focused unit decision/ownership tests, live Action restriction and selected-context denial, persisted replay non-duplication assertions, and post-write evidence-flush rollback proof.
- Standards/architecture review: PASS after keeping Customer version mutation in `CustomerRepository` and composing it explicitly without making the read-only `CustomerLookup` boundary mutation-capable.
- Final audit found no changes outside `app/`, no edits to read-only `mvp/` or `mvp2/`, no unrelated feature expansion, and no remaining review findings.

### Deviations and Notes

- The first full build used the worktree placeholder revision and correctly failed the promotable release-envelope guard. The final production build passed with the exact immutable `develop` base revision and an isolated nonexistent `GIT_DIR`; generated build output remains ignored.
- A chained validation attempt initially scoped database environment variables only to its first command. The remaining commands were rerun individually with explicit isolated database configuration and all passed.
