---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer detail business fields

## Feature Description

Display all canonical Customer business fields on the existing Customer detail page as one ordinary
Customer information set. Do not create a separate ARES panel, synchronization history, address
section, or activity list.

## User Story

As a CRM user
I want to see a Customer's complete Czech business identity
So that I can review the canonical record without opening the edit form

## Problem Statement

The current detail page shows name, IDs, lifecycle, and timestamps only. After contracts expand, the
page needs localized labels, date formatting, null handling, and responsive/accessibility coverage
for the new fields while preserving contacts and lifecycle controls.

## Solution Statement

Extend the existing ready-state view model and detail definition layout with IČO, DIČ, legal-form
code, establishment date, and dissolution date. Use existing UI-kit/layout patterns and locale-aware
date-only formatting; show a consistent unavailable-value label for null fields.

## Relevant Files

Use these files to implement the feature:

- `docs/frontend/FRONTEND.md` — view-model, UI-kit, state, accessibility, and responsive rules.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx` — existing generated Customer detail page.
- `verticals/crm/src/api/customer-detail-client.ts` — complete Customer read client.
- `verticals/crm/tests/components/customer-detail-page.test.tsx` — detail rendering and state tests.
- `verticals/crm/locales/cs/crm.json` — Czech field labels and unavailable copy.
- `verticals/crm/locales/en/crm.json` — English field labels and unavailable copy.

## Implementation Plan

### Phase 1: Foundation

Consume the expanded Customer detail DTO and extend only the existing ready-state view model and
copy contract.

### Phase 2: Core Implementation

Render the fields in the current Customer information layout using semantic markup, stable code
display, locale-aware dates, and consistent null values.

### Phase 3: Integration

Preserve lifecycle actions, contacts, query/error states, responsiveness, i18n, and focused tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Expand the detail view model

- [x] Add display values for IČO, DIČ, legal-form code, establishment date, and dissolution date to the ready model; retain `name` as the canonical business name.
- [x] Format date-only values without timezone shifts and map null fields to one localized unavailable-value string.

### 2. Render ordinary Customer information

- [x] Add localized semantic label/value rows in the existing detail information surface with copyable text behavior where already established.
- [x] Do not add an ARES heading, source/upload metadata, refresh button, address block, CZ-NACE, or activities.

### 3. Preserve existing page behavior

- [x] Keep loading, not-found, forbidden, unavailable/retry, archived/active lifecycle, edit/navigation actions, contacts table, and responsive layout behavior unchanged.
- [x] Ensure narrow layouts wrap long DIČ/code values without horizontal page overflow and that screen readers retain clear label/value relationships.

### 4. Add localized copy and component tests

- [x] Add matching Czech/English labels for every field and the unavailable value with no hardcoded visible copy.
- [x] Extend detail tests for complete and null Customers, leading-zero IČO, localized dates without timezone drift, archived state, responsive semantics, contacts coexistence, and absence of ARES/address sections.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve detail-specific failures only.

## Testing Strategy

### Unit Tests

Test the view-model/date formatter with complete/null values and locale/timezone boundaries where it
is extracted as a pure helper.

### Integration Tests

Use existing component integration with the generated detail client; the contract/BFF spec already
proves the real read seam, so no duplicate external runtime test is required.

### Edge Cases

- Leading-zero IČO.
- All optional values null.
- Establishment or dissolution date near a timezone boundary.
- Long DIČ or narrow viewport.

## Acceptance Criteria

- [x] Customer detail displays all six canonical business fields.
- [x] Null and date-only values are rendered consistently and correctly.
- [x] New information is part of the ordinary Customer details, not an ARES section.
- [x] Existing lifecycle and contacts behavior remains intact.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component` — validate detail rendering and unchanged states.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate expanded detail view models.
- `mise exec -- pnpm i18n:boundaries` — validate Czech/English field copy.
- `mise exec -- pnpm --filter @app/crm build` — compile the expanded detail page.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-contracts-reads.md`.
- Resolving `legalFormCode` to a human-readable code-list label is a separate enhancement; this feature displays the canonical stored code.

## Implementation Evidence

### Summary

- Extended the existing Customer detail ready model and semantic definition list with IČO, DIČ,
  legal-form code, establishment date, and dissolution date while preserving the canonical name,
  lifecycle controls, contacts, and existing UI states.
- Added UTC-pinned locale-aware date-only formatting, one localized unavailable value, stable code
  display, and wrapping-safe narrow-layout styles.

### Changed Files

`git diff --stat` reports 4 tracked files changed, 160 insertions, and 10 deletions. This
implementation plan is a new file carried from the original checkout into the isolated worktree.

### Tests Written or Updated

- `verticals/crm/tests/components/customer-detail-page.test.tsx` — proves complete and null Customer
  rendering, leading-zero IČO, English/Czech date-only formatting, archived state, semantic
  label/value relationships, wrapping classes, contacts coexistence, loading geometry, locale
  parity, and absence of ARES/address sections.

### Validation

- `mise exec -- pnpm --filter @app/crm test:component` — passed; 9 files and 187 tests.
- `TZ=America/Los_Angeles mise exec -- pnpm --filter @app/crm test:component` — passed; 9 files and
  187 tests with a negative-offset timezone.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed after the fresh worktree's shared
  declaration cache was generated.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm --filter @app/crm build` — compiled the CRM server/client and federated types,
  then the expected dirty-worktree release-envelope guard rejected `sourceRevision "workspace"`.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-detail-business-fields ULTRAMODERN_SOURCE_REVISION=6cf972b2c3c61c6bb845f4a39980622b76245f23 mise exec -- pnpm --filter @app/crm build` — passed the complete CRM build and packaging pipeline.
- `mise exec -- pnpm check` — initially found `unicorn(prefer-spread)` in the updated component test;
  fixed and rerun successfully through every repository gate.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-detail-business-fields ULTRAMODERN_SOURCE_REVISION=6cf972b2c3c61c6bb845f4a39980622b76245f23 mise exec -- pnpm build` — passed CRM, Shell, Module Federation type assertions, and performance readiness.
- `mise exec -- pnpm --filter @app/crm dev` plus in-app browser review — development build passed;
  the standalone route preserved loading/error semantics and had no horizontal page overflow at
  360 px (`scrollWidth = viewportWidth = 360`).

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`,
  `docs/architecture/ACTIONS.md`, `docs/architecture/ERRORS.md`,
  `docs/architecture/ULTRAMODERN.md`, `docs/architecture/MODULE_ENTRYPOINTS.md`,
  `docs/architecture/MODULE_MANIFESTS.md`, and `docs/frontend/FRONTEND.md`; reviewed the complete
  specification and final diff. The generated Effect client seam, typed UI error mapping,
  MicroVertical boundary, page entrypoint, UI-kit/Tailwind rules, and i18n boundary remain intact.
- Fixed the only task-local review finding (the repository's spread-syntax lint rule) and reran the
  affected tests plus the complete quality gate. No remaining blocker, skippable, or tech-debt
  findings were identified.
- Browser evidence: `.codex/reports/review/feature-crm-customer-detail-business-fields/customer-detail-narrow-error.png`.

### Deviations and Follow-ups

- No implementation deviation. The plain dirty-worktree build cannot emit promotable release
  metadata by design; deterministic base-revision builds passed for both CRM and the full workspace.
- The standalone CRM browser session had no authenticated Shell/BFF context, so the ready-state
  record could not be exercised there. It correctly rendered the existing retryable error state;
  complete, null, archived, contacts, and responsive ready states are covered by the passing
  component integration suite.
