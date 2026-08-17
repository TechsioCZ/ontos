---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer Actions for business fields

## Feature Description

Extend the existing generated Customer create/edit Actions and lifecycle results to govern all
approved Customer business fields, including a typed same-tenant duplicate-IČO conflict.

## User Story

As a CRM user
I want Customer business identity changes to use the normal governed Actions
So that manually entered or ARES-prefilled values receive the same validation, idempotency, audit, and transaction guarantees

## Problem Statement

The current create/edit Actions accept only `name`, and persistence maps every database failure to
unavailability. That cannot represent complete Customer writes or a recoverable duplicate-IČO
conflict.

## Solution Statement

Adapt the already-generated create/edit Customer Actions and BFF mappings to the expanded canonical
payloads. Add a typed CRM domain error for the known IČO uniqueness conflict, preserve complete
Customer results for all four lifecycle Actions, and rely on Core request hashing over the complete
normalized payload for idempotency.

## Relevant Files

Use these files to implement the feature:

- `docs/architecture/ACTIONS.md` — Action lifecycle, idempotency, evidence, and transaction rules.
- `docs/architecture/ERRORS.md` — typed domain-to-HTTP conflict mapping.
- `verticals/crm/src/actions/create-customer.action.ts` — generated create Action.
- `verticals/crm/src/actions/edit-customer.action.ts` — generated edit Action.
- `verticals/crm/src/actions/archive-customer.action.ts` — lifecycle result contract.
- `verticals/crm/src/actions/unarchive-customer.action.ts` — lifecycle result contract.
- `verticals/crm/src/services/customer-contact-persistence.service.ts` — Action persistence services.
- `verticals/crm/shared/api.ts` — mutation endpoint error and success contracts.
- `verticals/crm/api/index.ts` — Action execution and public Problem Details mapping.
- `verticals/crm/tests/unit/customer-contact-action-contract.test.ts` — Action descriptor tests.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — real Action runtime proof.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — generated client/BFF proof.

## Implementation Plan

### Phase 1: Foundation

Consume the canonical schemas and typed persistence outcomes from dependencies 1 and 2. Do not run
`scaffold:action`: these Actions already exist and must retain their generated identities.

### Phase 2: Core Implementation

Expand create/edit services and results, add duplicate-IČO as a declared domain conflict, and map it
to the existing typed `409` BFF Problem Details contract.

### Phase 3: Integration

Prove complete payload hashing, retries, tenant isolation, audit/evidence, lifecycle results, and
rollback using the real Action runtime and strict BFF.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Expand existing Action contracts

- [x] Expand `CreateCustomerPayloadSchema` and `EditCustomerPayloadSchema` with nullable `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn`, retaining `customerId` as edit-only and excluding all ARES metadata/address/activity fields.
- [x] Adapt `CreateCustomerAction` and `EditCustomerAction` to consume the expanded generated payload/result schemas while preserving keys, owners, schema identities, idempotency, evidence, permissions, and legal-entity scope.
- [x] Confirm archive/unarchive Actions return the expanded `CustomerSchema` without accepting the new business fields in lifecycle payloads.

### 2. Model duplicate IČO as a typed conflict

- [x] Add a Customer IČO conflict tagged error to the canonical CRM error vocabulary and include it in create/edit domain error schemas.
- [x] Map only the named Customer tenant/IČO unique constraint to that error; keep unrelated database failures typed as persistence unavailable.
- [x] Exhaustively map the conflict to the existing declared `409` Problem Details response without exposing constraint names or tenant information.

### 3. Preserve complete mutation behavior

- [x] Persist normalized `name`, `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn` atomically on create/edit.
- [x] Verify Core idempotency hashes the complete decoded payload: uncertain same-payload retries replay, while any changed field with the same key conflicts.

### 4. Extend Action and BFF tests

- [x] Add descriptor/unit assertions for complete payload/result/error schemas and unchanged generated Action identity.
- [x] Add operation tests for complete create/edit, null clearing, validation rollback, duplicate conflicts on create and edit, tenant isolation, archive/unarchive complete results, audit/evidence, and idempotent replay/hash conflict.
- [x] Extend BFF tests to prove `400`, `409`, and retryable `503` remain distinguishable through the generated Effect client.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve Action-related failures without adding a lookup mutation Action.

## Testing Strategy

### Unit Tests

Validate Action descriptors, complete schemas, domain error unions, generated identities, and
exhaustive BFF mapping.

### Integration Tests

Run the real Core Action runtime with CRM persistence and strict BFF to prove atomic writes,
idempotency, rollback, evidence, isolation, and typed duplicate conflicts.

### Edge Cases

- Create/edit with all optional fields null.
- Clearing previously populated optional fields.
- Same IČO in another tenant versus active/archived Customer in the same tenant.
- Same idempotency key with one changed date or code.

## Acceptance Criteria

- [x] Create/edit govern every approved Customer field in one transaction.
- [x] Duplicate same-tenant IČO is a declared `409`, not `503`.
- [x] Archive/unarchive return the complete Customer.
- [x] No new ARES lookup Action is introduced.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate Action descriptors and error contracts.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate real Action/BFF persistence, conflicts, and idempotency.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate Action service and error-channel types.
- `mise exec -- pnpm action:test:unit` — validate shared Action runtime behavior.
- `mise exec -- pnpm api:check` — validate strict mutation BFF topology.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-business-fields.md` and `feature-crm-customer-contracts-reads.md`.
- The lookup read may prefill values, but these Actions persist the final user-confirmed Customer payload without tracking its source.

## Implementation Evidence

### Summary

- Expanded the existing generated Customer create/edit Action payloads to govern every approved
  business field with shared normalization and lifecycle-date validation.
- Added a closed `CrmCustomerIcoConflict` domain error, exact PostgreSQL constraint classification,
  and exhaustive mapping to the existing declared `409` Problem Details contract.
- Persisted complete create/edit payloads atomically and updated the generated-client page
  integrations so edit prefill, null clearing, and uncertain-retry identity include every field.
- Preserved the existing Action keys, owners, entrypoints, permissions, idempotency, evidence,
  legal-entity scopes, lifecycle payloads, and complete lifecycle result schema.

### Changed Files

- `verticals/crm/shared/apis/customer-detail.ts` — complete mutation schemas and typed IČO conflict.
- `verticals/crm/src/actions/create-customer.action.ts` and
  `verticals/crm/src/actions/edit-customer.action.ts` — declared domain error unions.
- `verticals/crm/src/services/customer-contact-persistence.service.ts` — complete atomic writes and
  exact uniqueness-error classification.
- `verticals/crm/api/index.ts` — exhaustive safe `409` mapping.
- Customer create/edit route integration — complete generated-client payloads, edit prefill, and
  complete logical retry comparison.
- CRM unit, component, BFF integration, and database-backed Action integration tests.

### Tests Written or Updated

- Contract tests cover complete/nullable schemas, normalization, date ordering, excluded ARES
  metadata, lifecycle payload closure, unchanged Action identities, complete result schemas, and
  declared error unions.
- Persistence tests cover complete create/edit values, null clearing, exact named-constraint
  mapping, unrelated uniqueness failures, and diagnostic redaction.
- Component tests cover complete create payloads, complete edit prefill/submission, and changed-field
  idempotency intent.
- Governed runtime tests cover complete create/edit, clearing, validation rollback, active and
  archived duplicate IČO, edit conflicts and rollback, cross-tenant reuse, lifecycle results,
  durable audit/evidence, same-payload replay, and changed-payload hash conflict.
- Strict BFF tests prove `400`, `409`, and retryable `503` remain distinct through the generated
  Effect client and do not expose internal constraint or tenant details.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 46 tests.
- `mise exec -- pnpm --filter @app/crm test:component -- tests/components/customer-create-page.test.tsx tests/components/customer-edit-page.test.tsx` — passed, 208 tests across 10 component files.
- `DATABASE_ADMIN_URL=<isolated-test-admin-url> DATABASE_URL=<isolated-test-runtime-url> mise exec -- pnpm --filter @app/crm test:integration` — passed, 4 tests against a freshly migrated PostgreSQL 17 database.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm action:test:unit` — passed, 58 tests.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm check` — passed the complete repository quality gate.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-actions ULTRAMODERN_SOURCE_REVISION=b0cc68d6a3479fe73f9f7085b867ba2e57f72a43 mise exec -- pnpm build` — passed the complete CRM, Shell, Module Federation type, deploy-output, and performance build.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, and the relevant MicroVertical, Action, error, database,
  governed-data-access, module-entrypoint, module-manifest, UltraModern, and frontend guidance.
- Reviewed the complete diff against every task, acceptance criterion, edge case, and review item.
  The final review found no remaining correctness, security, boundary, or scope issues.
- Confirmed no new Action, page, Outbox Message, Policy, ARES mutation, manifest entry, or other
  generator-owned artifact was created. The existing generated Actions were adapted as the plan
  explicitly requires, so `scaffold:action` was intentionally not run.

### Deviations

- The first database-backed test invocation stopped at the repository's typed missing-configuration
  error because a new worktree has no database environment. Validation then used an isolated
  temporary PostgreSQL 17 instance, the repository migration/bootstrap commands, and separate
  least-privilege admin/runtime URLs; the unchanged test command passed with those URLs supplied.
- The literal dirty-worktree build compiled the CRM client/server and passed TS-Go, then the
  release-envelope guard correctly rejected placeholder revision `workspace`. The final build used
  the immutable base revision shown above and passed completely.
- No implementation scope or architecture deviations remain.
