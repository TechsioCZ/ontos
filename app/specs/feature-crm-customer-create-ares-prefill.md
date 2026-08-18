---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer create ARES prefill

## Feature Description

Integrate the owner-private ARES loader and generated lookup read into the existing Customer create
page. Successful lookup applies flat Customer values to the controlled form, lets the user review
and edit them, and persists the final values through the existing CreateCustomerAction.

## User Story

As a CRM user creating a Czech Customer
I want to prefill its business identity from ARES
So that I can avoid retyping public data while retaining control of the saved Customer

## Problem Statement

The lookup API, loader, and controlled Customer form are separate building blocks. The create route
must own their application state, typed Effect execution, mapping, retry, prefill policy,
idempotency, and final mutation without coupling presentation to data infrastructure.

## Solution Statement

Render `CustomerAresLoader` as a sibling before `CustomerForm`. Use a page-owned TanStack mutation
adapter to run the generated ARES lookup Effect on explicit valid IČO submission. On success,
replace `name` and `ico`, apply non-null optional ARES values, and retain manually entered optional
values when ARES omits them. Save the resulting controlled Customer values through `createCustomer`.

## Relevant Files

Use these files to implement the feature:

- `docs/frontend/FRONTEND.md` — route/data ownership and explicit UI states.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/new/page.tsx` — existing generated create integration.
- `verticals/crm/src/features/customers/customer-form.tsx` — controlled Customer values.
- `verticals/crm/src/features/customers/customer-ares-loader.tsx` — lookup presentation.
- `verticals/crm/src/api/customer-ares-lookup-client.ts` — generated Effect lookup client.
- `verticals/crm/src/api/crm-client.ts` — generated Customer mutation client.
- `verticals/crm/tests/components/customer-create-page.test.tsx` — create-page behavior tests.
- `verticals/crm/locales/cs/crm.json` — Czech lookup/create copy.
- `verticals/crm/locales/en/crm.json` — English lookup/create copy.

## Implementation Plan

### Phase 1: Foundation

Consume completed Action, lookup BFF, controlled form, and loader dependencies; preserve the existing
generated page identity, route, target gating, and navigation.

### Phase 2: Core Implementation

Own lookup and form state in the page, map the complete typed lookup error union to presentation,
apply the deterministic prefill policy, and submit the final payload with correct idempotency.

### Phase 3: Integration

Complete localized states, accessibility, responsive composition, focused page tests, and real BFF
coverage for both lookup and Customer creation.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Compose loader and controlled form

- [x] In the existing generated Customer create page, render `CustomerAresLoader` and `CustomerForm` as siblings under one page-owned values model; do not nest their submit boundaries or modify page/module identity.
- [x] Keep lookup available only after the resolved CRM target is readable and Customer creation enabled only when `target.writable` is true.

### 2. Execute lookup through the generated client

- [x] On the loader's semantic callback, run only the generated `customer-ares-lookup` Effect client through the page query/mutation adapter with fresh correlation context; never use direct `fetch`, call ARES, or import backend code.
- [x] Exhaustively map invalid, authentication, forbidden, not-found, retryable unavailable, internal, transport, and decode failures to localized loader states with bounded retry only for uncertain failures.

### 3. Apply the lookup result to Customer values

- [x] On success, always set canonical `ico` and `name`; replace optional DIČ/legal-form/date values only when ARES supplied non-null values, retaining manually entered optional values otherwise.
- [x] Clear stale lookup errors, announce success accessibly, keep every populated field editable, and do not persist or display source/upload metadata.

### 4. Submit the complete Customer

- [x] Map controlled strings to the canonical nullable payload and call the existing generated `createCustomer` mutation client; keep route `id` out of the business payload.
- [x] Base logical idempotency intent on all normalized Customer fields, reuse a key only for an uncertain identical retry, and issue a new key after any field changes.
- [x] Preserve existing conflict/authentication/unavailable/success mapping and localized list navigation.

### 5. Add localized page and integration tests

- [x] Extend Czech/English create copy for lookup label/button/loading/success/not-found/forbidden/unavailable/retry and added form fields with parity and no hardcoded strings.
- [x] Extend page tests for no lookup before valid emission, exact client input, every typed lookup state, prefill policy, manual correction, omitted optional values, no nested/double submit, non-writable gating, complete create payload/idempotency, and success navigation.
- [x] Extend real CRM integration coverage to prove lookup uses the generated read and creation uses the Action, with deterministic ARES substitution and no persisted ARES metadata/address.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve create-integration failures only.

## Testing Strategy

### Unit Tests

Use component tests with mocked generated Effect clients and a real query provider to validate
state mapping, prefill, manual editing, mutation payloads, idempotency, accessibility, and navigation.

### Integration Tests

Run the strict CRM BFF with a substituted ARES service and real Action runtime to prove the complete
lookup-to-confirmed-create flow without external network dependency.

### Edge Cases

- ARES returns no DIČ, legal form, or dates after the user entered them manually.
- User starts a second lookup after editing the first result.
- Lookup succeeds but Customer creation later conflicts on IČO.
- Target is readable but not writable.

## Acceptance Criteria

- [x] Valid lookup prefills ordinary Customer fields on the create form.
- [x] The user can edit all prefilled values before saving.
- [x] Final values are persisted only through CreateCustomerAction.
- [x] Lookup and create errors/states remain distinct, localized, and accessible.
- [x] No address, nested ARES data, or upload metadata is saved.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component` — validate create lookup, prefill, form, and mutation behavior.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate generated lookup BFF plus real Customer Action persistence.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate controlled state and typed client errors.
- `mise exec -- pnpm i18n:boundaries` — validate localized lookup/create copy.
- `mise exec -- pnpm api:check` — prevent direct browser/backend bypasses.
- `mise exec -- pnpm --filter @app/crm build` — compile the CRM create page and generated clients.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-action-fields.md`, `feature-crm-ares-lookup-bff.md`, `feature-crm-customer-form-business-fields.md`, and `feature-crm-customer-ares-loader.md`.
- ARES is an autofill convenience only; the persisted record contains the final user-confirmed Customer values.

## Implementation Evidence

### Summary

- Composed the owner-private ARES loader with the controlled Customer create form, using the generated typed Effect lookup client, exhaustive localized states, bounded uncertain retry, deterministic prefill, and concurrency guards.
- Preserved the existing generated page, Shell target gating, complete normalized create payload, logical idempotency behavior, and `CreateCustomerAction` persistence path.
- Added focused component and real governed-runtime integration coverage, including proof that no address, nested ARES, source, or upload metadata is persisted.

### Changed Files

```text
verticals/crm/locales/cs/crm.json                              |  17 ++
verticals/crm/locales/en/crm.json                              |  17 ++
verticals/crm/src/routes/[lang]/crm/customers/[id]/new/page.tsx | 198 +++++++++++-
verticals/crm/tests/components/customer-create-page.test.tsx   | 338 ++++++++++++++++++++-
verticals/crm/tests/integration/customer-ares-lookup-bff.test.ts |  64 +++-
verticals/crm/tests/integration/customer-contact-operations.test.ts |  90 +++++-
6 tracked source/test files changed, 702 insertions(+), 22 deletions(-)
specs/feature-crm-customer-create-ares-prefill.md               | plan status, checklist, and evidence
```

### Tests Written or Updated

- `verticals/crm/tests/components/customer-create-page.test.tsx` — proves sibling submit boundaries, valid lookup emission, exact generated-client input, exhaustive typed state mapping, bounded retry with fresh correlation, deterministic optional-field retention/replacement, editable prefill, lookup/create concurrency, non-writable gating, complete flat payload, idempotency, localization, and navigation.
- `verticals/crm/tests/integration/customer-ares-lookup-bff.test.ts` — proves the generated lookup and create clients cross the real CRM BFF, the read is governed with deterministic ARES substitution, and creation dispatches the registered create Action payload without ARES metadata.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — proves the governed ARES read feeds the real Action runtime, persists only reviewed canonical Customer fields, and stores no address/ARES/source/upload fields.

### Validation

- `mise exec -- pnpm --filter @app/crm exec rstest tests/components/customer-create-page.test.tsx` — passed, 31/31 tests.
- `mise exec -- pnpm --filter @app/crm exec node --test tests/integration/customer-ares-lookup-bff.test.ts` — passed, 1/1 test.
- `DATABASE_ADMIN_URL=<isolated-test-db> DATABASE_URL=<isolated-test-db> mise exec -- pnpm db:migrate` — passed against the disposable PostgreSQL database.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 225/225 tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 4/4 tests with the isolated PostgreSQL URLs supplied through the environment; the first environment-free attempt failed before database-backed tests because `DATABASE_URL` was required.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed; an earlier rerun found an ignored dev-router artifact created during browser validation, which was moved to Trash before the successful rerun.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm --filter @app/crm build` — application compilation passed; the literal dirty-worktree command stopped at the release-envelope guard, then the same command passed with `ULTRAMODERN_SOURCE_REVISION=80454c42e9ae8646ca11ede17c12a4ff74c970e6` and a worktree ceiling supplied.
- `mise exec -- pnpm check` — passed after repository formatting and sorted-key lint fixes.
- `mise exec -- pnpm build` — the skill-required root build passed with the immutable base source revision and worktree ceiling supplied; the literal dirty-worktree command stopped only at the same release-envelope guard.
- CRM dev server plus the in-app browser — passed the critical read-only loader, independent form boundaries, local IČO validation, and retryable lookup-feedback checks.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `ULTRAMODERN.md`, `MODULE_ENTRYPOINTS.md`, `MODULE_MANIFESTS.md`, `DATA_ACCESS.md`, `docs/frontend/FRONTEND.md`, `docs/integrations/ares.md`, and relevant repository product context.
- Verified the final diff uses only the generated Effect BFF clients, preserves owner-private implementation and module boundaries, maps the closed typed error unions exhaustively, persists only through the existing Action, uses existing UI-kit components, and keeps all user-facing copy localized.
- Fixed one blocker found during review: create submission could race an unresolved ARES lookup. The create form and submit adapter now guard lookup-pending state, with a focused regression test.
- Resolved formatter/sorted-key lint drift and removed the disposable ignored router artifact produced by the browser dev server. No unresolved findings remain.
- Browser evidence: `.codex/reports/review/feature-crm-customer-create-ares-prefill/customer-create-ares-validation.png`.

### Deviations and Follow-ups

- No Codesmith generator was applicable because the work adapted an existing generated page and existing package-owned tests; it did not create a new Action, page, API, component, outbox message, Policy, or adapter.
- The repository-level `../docs/05_MICROVERTICALS.md` still describes joint deployment, while authoritative app-local guidance requires independent deployment. This implementation follows the app-local rule and introduces no cross-vertical dependency.
- Dirty worktrees intentionally produce `sourceRevision = workspace`, which the promotable release-envelope guard rejects. Package and root builds both passed with the immutable starting commit supplied as the validation revision.
- No remaining blockers or follow-ups.
