---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer edit business fields

## Feature Description

Update the existing Customer edit page to load, display, validate, and save all canonical Customer
business fields through the controlled Customer form and existing EditCustomerAction. The ARES
loader remains create-only.

## User Story

As a CRM user
I want to correct any Customer business field
So that the canonical Customer record remains accurate after creation

## Problem Statement

The edit page currently initializes and submits only `name`. Once the canonical Customer expands,
the page must preserve optional values, allow explicit clearing, classify field/conflict errors, and
include the complete payload in logical idempotency behavior.

## Solution Statement

Map the expanded detail response into controlled form strings, submit normalized nullable values
through the generated `editCustomer` Effect client, and update all query-cache, error, idempotency,
and component tests. Do not add ARES lookup controls or a separate ARES section.

## Relevant Files

Use these files to implement the feature:

- `docs/frontend/FRONTEND.md` — route integration, typed errors, controlled presentation, and UI states.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — existing generated edit owner.
- `verticals/crm/src/features/customers/customer-form.tsx` — expanded controlled form.
- `verticals/crm/src/api/customer-detail-client.ts` — generated detail read client.
- `verticals/crm/src/api/crm-client.ts` — generated edit mutation client.
- `verticals/crm/tests/components/customer-edit-page.test.tsx` — edit behavior tests.
- `verticals/crm/locales/cs/crm.json` — Czech edit copy.
- `verticals/crm/locales/en/crm.json` — English edit copy.

## Implementation Plan

### Phase 1: Foundation

Consume the expanded read/Action contracts and controlled form without changing the generated page,
route, federation, or Shell identity.

### Phase 2: Core Implementation

Map nullable DTO values to form values, normalize changed values back to the edit payload, and
preserve typed error and idempotency semantics across every field.

### Phase 3: Integration

Complete localized field/conflict states, cache updates, responsive/accessibility behavior, and
focused page plus real BFF tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Load complete Customer values

- [x] Map `name`, `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn` from the generated Customer detail client into controlled form strings, rendering null values as empty controls.
- [x] Preserve existing loading, not-found, forbidden, unavailable/retry, archived, and non-writable page states.

### 2. Submit complete edits

- [x] Normalize empty optional controls to null and call only the generated `editCustomer` client with `customerId` plus all six business fields.
- [x] Keep ARES loader/client/imports out of the edit page; all values are ordinary editable Customer data.

### 3. Update errors and idempotency

- [x] Map structural validation to the correct fields, duplicate-IČO conflict to a safe actionable form status, not-found/authentication/forbidden states as currently established, and uncertain failures to retry guidance.
- [x] Define logical intent over the complete normalized payload: same-payload uncertain retry reuses the key; changing or clearing any field creates a new key.

### 4. Preserve cache and navigation behavior

- [x] On success, write the complete returned Customer into the detail cache or invalidate it consistently, announce success, and navigate to the existing localized destination.
- [x] Keep Back/Cancel mutation-free and preserve unsaved controlled values during retryable errors.

### 5. Add copy and focused tests

- [x] Complete Czech/English edit labels, validation, duplicate conflict, and success/error messages with parity.
- [x] Extend page tests for complete/null prefill, clearing fields, exact payload, each field validation, duplicate IČO, full-payload idempotency, pending guards, cache result, navigation, writable gating, and absence of ARES lookup UI.
- [x] Extend the real BFF/Action test for complete edit and duplicate-IČO conflict decoding.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve edit-specific failures only.

## Testing Strategy

### Unit Tests

Use Testing Library with mocked generated Effect clients to cover read mapping, controlled edits,
nullable normalization, every explicit state, idempotency, cache, and navigation.

### Integration Tests

Use the strict CRM BFF and real EditCustomerAction to prove complete persistence, null clearing,
tenant isolation, and duplicate-IČO conflict.

### Edge Cases

- Customer has only a name and all optional fields null.
- User clears one or every optional field.
- IČO changes to one already used by an active or archived Customer.
- A retry begins after one field changes.

## Acceptance Criteria

- [x] Edit loads and saves all canonical Customer fields.
- [x] Optional fields can be explicitly cleared.
- [x] Duplicate IČO and validation failures are typed and actionable.
- [x] Complete-payload idempotency and cache behavior are correct.
- [x] No ARES loader appears on edit.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component` — validate edit-page states and interactions.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate real edit Action/BFF persistence and conflicts.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate page mappings and typed errors.
- `mise exec -- pnpm i18n:boundaries` — validate edit copy ownership and parity.
- `mise exec -- pnpm --filter @app/crm build` — compile the expanded edit page.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-action-fields.md`, `feature-crm-customer-contracts-reads.md`, and `feature-crm-customer-form-business-fields.md`.
- ARES-assisted refresh on edit is intentionally outside scope.

## Implementation Evidence

### Summary

- Completed the controlled edit flow for all canonical Customer business fields, nullable clearing, complete-payload idempotency, cache/navigation behavior, typed duplicate-IČO feedback, and Czech/English copy.
- Preserved the existing generated page, Action, BFF client, module-entrypoint, and MicroVertical boundaries; no new business artifact required Codesmith generation.

### Changed Files

- 10 tracked implementation/test files changed with 296 insertions and 26 deletions; this 188-line specification was added to the worktree and completed as the eleventh file.

### Tests Written or Updated

- `verticals/crm/tests/components/customer-edit-page.test.tsx` — complete and nullable prefill, per-field validation, explicit clearing, exact payload, complete-intent idempotency, pending guards, retry draft preservation, cache/navigation, writable state, typed duplicate-IČO feedback, and absence of ARES UI.
- `verticals/crm/tests/components/customer-form.test.tsx` — canonical 20-character DIČ validation.
- `verticals/crm/tests/unit/customer-contact-api-contract.test.ts` — both typed public conflict codes decode through the declared 409 Problem Details schema.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — complete edit payload/result and create/edit duplicate-IČO decoding through the real governed BFF boundary.

### Validation

- `mise exec -- pnpm --filter @app/crm exec node --test tests/unit/customer-contact-api-contract.test.ts` — passed (5 tests).
- `mise exec -- pnpm --filter @app/crm exec node --test tests/integration/customer-contact-bff.test.ts` — passed (1 test).
- `mise exec -- pnpm --filter @app/crm test:component` — passed (10 files, 221 tests).
- `DATABASE_ADMIN_URL=postgresql://ontos_admin:<ephemeral-password>@localhost:15435/ontos_edit DATABASE_URL=postgresql://ontos_runtime:<ephemeral-password>@localhost:15435/ontos_edit mise exec -- pnpm --filter @app/crm test:integration` — passed (4 integration files against an isolated temporary PostgreSQL database, removed afterward).
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-edit-business-fields ULTRAMODERN_SOURCE_REVISION=80454c42e9ae8646ca11ede17c12a4ff74c970e6 mise exec -- pnpm --filter @app/crm build` — passed, including TypeScript, federated types, manifests, and Node deploy output.
- `mise exec -- pnpm check` — passed after review fixes.
- `PORT=4101 mise exec -- node verticals/crm/.output/index` with browser validation at `/en/crm/customers/11111111-1111-4111-8111-111111111111/edit` — passed the built-page hydration, localized heading, explicit retry state/control, and no-ARES runtime checks; authenticated writable-form behavior is covered by component and integration tests.

### Review

- Reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, the complete specification, `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `ULTRAMODERN.md`, `FRONTEND.md`, `MODULE_ENTRYPOINTS.md`, relevant product context, and the `@techsio/ui-kit` consumer audit.
- Fixed review findings by moving the no-ARES assertion into a rendered page test, removing an obsolete diagnostic suppression, and proving both allowed typed conflict codes. The final review found no remaining blocker, dead code, boundary violation, unrelated change, or accidental public API expansion.
- No screenshot was retained because the standalone preview can validate only the unauthenticated/retry surface; the critical writable flow has stronger deterministic component and real integration evidence.

### Deviations and Follow-ups

- Fresh-worktree package typechecking initially required project-reference declaration materialization; the plan's exact CRM typecheck command passed afterward without code changes.
- The first build used the generated `workspace` revision and correctly failed the promotable-envelope gate; rerunning with the documented immutable worktree revision passed.
- No product or architecture follow-up remains.
