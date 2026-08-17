---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer contracts and reads for business fields

## Feature Description

Publish the Customer business fields as ordinary top-level members of the canonical CRM Customer
contract and carry them through the existing Customer detail and list reads. Preserve the generated
Effect BFF seam and typed error behavior.

## User Story

As a CRM frontend feature
I want every Customer read to return the complete business identity
So that create, edit, detail, and lifecycle flows share one canonical Customer representation

## Problem Statement

The expanded persistence and canonical Customer result still need to cross the existing detail/list
read descriptors and generated clients consistently before frontend pages can consume the fields.

## Solution Statement

Carry the canonical nullable business fields through existing detail/list read results, clients,
public exports, fixtures, and contract tests without nesting or source metadata. Mutation payload
expansion remains owned by the following Action spec.

## Relevant Files

Use these files to implement the feature:

- `AGENTS.md` — strict Effect BFF and module-entrypoint rules.
- `docs/architecture/MICROVERTICALS.md` — generated horizontal seam.
- `docs/architecture/ERRORS.md` — typed error and Problem Details behavior.
- `verticals/crm/shared/apis/customer-detail.ts` — canonical Customer result schema.
- `verticals/crm/shared/apis/customer-list.ts` — Customer list response.
- `verticals/crm/shared/api.ts` — public CRM API composition and exports.
- `verticals/crm/src/api/customer-detail.read.ts` — governed detail read.
- `verticals/crm/src/api/customer-list.read.ts` — governed list read.
- `verticals/crm/src/api/customer-detail-client.ts` — generated detail client adapter.
- `verticals/crm/src/api/customer-list-client.ts` — generated list client adapter.
- `verticals/crm/tests/unit/customer-contact-api-contract.test.ts` — schema/API contract coverage.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — real read BFF proof.

## Implementation Plan

### Phase 1: Foundation

Reuse the business-field formats established by dependency 1 in a single canonical Customer schema.

### Phase 2: Core Implementation

Expand existing generated module API contracts and persistence DTO results while preserving their
descriptors, endpoint identities, errors, and generated headers.

### Phase 3: Integration

Regenerate or update contract-derived types as required and prove exact round trips through detail
and list clients without changing list pagination or lifecycle semantics.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Confirm the canonical Customer result

- [x] Consume the top-level fields and reusable validation schemas established by `feature-crm-customer-business-fields.md`; do not introduce a second Customer result, nested ARES model, or mutation-payload changes in this task.
- [x] Verify all read fixtures explicitly represent optional fields as null rather than omitted.

### 2. Carry the schema through existing reads

- [x] Update Customer DTO construction so detail and list reads return all fields as declared, preserving nulls and date-only strings.
- [x] Keep `customer-detail` and `customer-list` generated descriptors, paths, read keys, evidence, authorization, pagination, and public error unions unchanged.

### 3. Update the public API and clients

- [x] Verify `shared/api.ts` exports and the existing generated Effect clients expose the expanded types without an alternate Customer or `AresData` contract.
- [x] Preserve typed transport/decoding failures and the existing RFC Problem Details status mappings.

### 4. Extend contract and BFF tests

- [x] Update unit fixtures and exact schema assertions for complete/null Customers, payload rejection, date ordering, and absence of extra fields.
- [x] Extend real BFF detail/list tests to prove all business fields cross the generated client seam, including leading-zero IČO and null values.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve only contract/read regressions.

## Testing Strategy

### Unit Tests

Decode valid complete and nullable Customer results; reject malformed IČO, legal form, dates,
unknown nested ARES data, and undeclared result members.

### Integration Tests

Use the generated clients against the CRM BFF to verify detail/list success and existing typed error
states with the expanded persisted DTO.

### Edge Cases

- Leading-zero IČO survives JSON and database round trips.
- Optional fields are null rather than omitted in Customer results.
- List pagination and archived filtering are unchanged.

## Acceptance Criteria

- [x] Every Customer result exposes the five added fields at top level.
- [x] Existing detail/list endpoint identities and typed errors remain stable.
- [x] No alternate or nested ARES Customer contract exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate Customer schemas and API descriptors.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate detail/list BFF round trips.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate generated client and contract types.
- `mise exec -- pnpm api:check` — enforce the generated Effect BFF seam.
- `mise exec -- pnpm module-entrypoints:check` — verify governed read descriptors remain exact.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-business-fields.md`.
- Customer list currently reuses `CustomerSchema`; this task preserves that established contract rather than introducing a second summary model.

## Implementation Evidence

### Summary

- Enforced chronological Customer business dates in the canonical Customer result schema while preserving the existing flat nullable business-field contract.
- Proved complete and nullable Customer detail/list results through governed reads and the generated Effect BFF clients, including typed Problem Details, decode, and transport failures.
- Updated every affected read fixture so nullable business fields are explicit `null` values.

### Changed Files

- `verticals/crm/shared/apis/customer-detail.ts` — canonical Customer date-order validation.
- `verticals/crm/tests/**` and `apps/shell-super-app/tests/e2e/login.spec.ts` — contract, governed-read, generated-client, component, and E2E fixture coverage.
- `specs/feature-crm-customer-contracts-reads.md` — completed plan and implementation evidence.
- Final aggregate: 12 files changed, 591 insertions, 20 deletions.

### Tests Written or Updated

- `verticals/crm/tests/unit/customer-contact-action-contract.test.ts` — complete/null exact decoding, required nullable members, date ordering, and malformed or extra-field rejection.
- `verticals/crm/tests/unit/customer-contact-api-contract.test.ts` — public Customer typing, exact governed descriptors, canonical schema reuse, generated-client seams, complete/null reads, and status-matched Problem Details.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — complete/null detail and list round trips, leading-zero IČO, typed 503 responses, malformed-success decoding, and closed-transport failures.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — persisted complete Customer mapping through `customerDto` and both governed reads with evidence.
- `verticals/crm/tests/components/customer-create-page.test.tsx`, `customer-detail-page.test.tsx`, `customer-edit-page.test.tsx`, and `customers-list-page.test.tsx` — explicit nullable Customer read fixtures.
- `verticals/crm/tests/support/e2e-customers.ts` and `apps/shell-super-app/tests/e2e/login.spec.ts` — explicit nullable E2E Customer responses.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 26 tests.
- `DATABASE_ADMIN_URL=postgresql://ontos_admin:ontos_admin@127.0.0.1:55433/ontos DATABASE_URL=postgresql://ontos_runtime:ontos_runtime@127.0.0.1:55433/ontos mise exec -- pnpm --filter @app/crm test:integration` — passed, 3 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 185 tests in 9 files with no skips.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check` — passed the complete repository quality gate after the review fixes.
- `mise exec -- pnpm format:check` — passed after the final plan update.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-contracts-reads ULTRAMODERN_SOURCE_REVISION=332a50011f8dc8bdcd1152b8ffbd0e8d7cffc294 mise exec -- pnpm build` — passed CRM, Shell, Module Federation type assertions, and performance readiness.

### Review

- Reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `ULTRAMODERN.md`, `DATABASE.md`, `DATA_ACCESS.md`, `MODULE_ENTRYPOINTS.md`, `MODULE_MANIFESTS.md`, and the relevant repository domain/scope guidance.
- Standards review passed after extracting the repeated Problem Details assertion loop into a helper.
- Specification review findings were fixed by adding decode/transport/list error coverage, proving a complete persisted row through the DTO and governed reads, and completing this evidence record.
- Screenshots were not applicable because the implementation changes contracts, reads, and test fixtures without changing rendered UI behavior.

### Deviations and Follow-ups

- The plain dirty-worktree build compiled but its release-envelope guard rejected the placeholder `sourceRevision "workspace"`; the documented immutable-revision build above passed completely.
- A fresh declaration bootstrap exposed unrelated Shell Module Federation path resolution during a supporting forced TypeScript build; the required CRM typecheck, full quality gate, and production build all pass. No feature follow-up remains.
