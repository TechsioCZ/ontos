---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer form business fields and prefill contract

## Feature Description

Expand the existing owner-private `CustomerForm` with all approved Customer business fields and
make it explicitly controlled so a parent can apply ARES-prefilled values after mount without a
React effect that copies props into local state.

## User Story

As a CRM user
I want one consistent Customer form for manual, prefilled, create, and edit flows
So that I can review and correct every Customer business field before saving

## Problem Statement

`CustomerForm` currently owns only a `name` state initialized once from props. Updating its initial
values after an ARES response would not update the mounted form, and duplicating the form for create
or edit would violate the established presentation boundary.

## Solution Statement

Refactor `CustomerForm` to a controlled plain-value contract and compose existing UI-kit
`FormInput`, `Button`, and `StatusText` components for `name`, `ico`, `dic`, `legalFormCode`,
`establishedOn`, and `dissolvedOn`. Keep BFF, Effect, route, permissions, and domain error types in
the owning pages.

## Relevant Files

Use these files to implement the feature:

- `docs/frontend/FRONTEND.md` — presentation ownership, controlled state, errors, accessibility, and React rules.
- `verticals/crm/src/features/customers/customer-form.tsx` — existing approved owner-private form.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/new/page.tsx` — current create owner.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — current edit owner.
- `verticals/crm/tests/components/customer-form.test.tsx` — reusable form behavior tests.
- `verticals/crm/locales/cs/crm.json` — Czech field and validation copy.
- `verticals/crm/locales/en/crm.json` — English field and validation copy.

## Implementation Plan

### Phase 1: Foundation

Define a plain controlled `CustomerFormValues`/copy/error contract matching canonical editable
fields, with no backend types or application behavior.

### Phase 2: Core Implementation

Compose UI-kit inputs, normalized validation, invalid-field focus, submit guards, and responsive
actions while removing one-time prop-to-state ownership.

### Phase 3: Integration

Temporarily adapt both owning pages to the controlled interface, add matching locale copy, and prove
the form can accept a parent-driven prefill without losing accessibility or edit behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the controlled presentation contract

- [x] Replace `initialValues` with controlled `values` plus semantic `onValuesChange`; include six string-based form values and field-error/copy entries without importing Customer/BFF/Effect/query types.
- [x] Keep pending, disabled, form status, cancel, and semantic submit callbacks compatible with create/edit owners.

### 2. Compose the complete form

- [x] Add UI-kit `FormInput` controls for name, IČO, DIČ, legal-form code, establishment date, and dissolution date; use date inputs for date-only values and responsive Tailwind layout only for composition.
- [x] Keep every field as ordinary Customer data with no ARES group, badge, source label, or metadata section.

### 3. Implement client-side validation and normalization

- [x] Require trimmed non-empty name; accept empty optional fields; require exact eight-digit IČO and exact three-digit legal-form code when present; apply the agreed bounded DIČ normalization; reject dissolution before establishment.
- [x] Normalize empty optional strings to the payload representation at the page/view-model boundary, focus the first invalid field, clear local errors on change, prevent duplicate submit, and preserve Enter submission.

### 4. Adapt owners and add component tests

- [x] Update create/edit page state just enough to own controlled values and preserve existing behavior; leave ARES-specific create integration and expanded edit mutation behavior to their dedicated specs.
- [x] Extend component tests for all controls, parent-driven value replacement after mount, change callbacks, normalization, each validation failure, focus order, null/empty display, keyboard submit, pending/disabled states, status announcements, cancel, and absence of BFF/application dependencies.

### 5. Complete field copy and validation

- [x] Add matching Czech/English field labels, hints, and validation messages under existing Customer create/edit namespaces with locale parity and no hardcoded visible strings.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve form-related failures without adding another form or UI-kit component.

## Testing Strategy

### Unit Tests

Use Rstest/Testing Library to render the form with plain props and prove controlled prefill, all
validation, semantic emissions, focus, keyboard, pending, accessible descriptions, and responsive
composition contracts.

### Integration Tests

Not required beyond adapting existing create/edit component tests: BFF mutations are handled by the
dedicated create/edit specs.

### Edge Cases

- Parent replaces values after the user has typed.
- IČO starts with zero.
- Optional fields are empty or cleared.
- Both dates exist and are equal or reversed.

## Acceptance Criteria

- [x] One controlled `CustomerForm` renders and edits all six Customer fields.
- [x] Parent-applied values render immediately without prop-copying effects or remount hacks.
- [x] Validation is localized, accessible, and aligned with canonical payload rules.
- [x] The form remains owner-private and application-independent.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component` — validate reusable form and owner compatibility.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate the controlled props and page integrations.
- `mise exec -- pnpm i18n:boundaries` — validate Czech/English ownership and parity.
- `mise exec -- pnpm --filter @app/crm build` — compile the CRM form in its remote application.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-customer-business-fields.md` for canonical validation semantics.
- The user explicitly approved expanding the existing Customer form; no new public component or UI-kit primitive is planned.

## Implementation Evidence

### Summary

- Refactored the owner-private Customer form to a six-field controlled contract, with localized hints and accessible client/server validation, normalization, invalid-field focus, and duplicate-submit protection.
- Adapted the existing create and edit owners to hold controlled form state and map empty optional strings to nullable payload-boundary values without expanding the existing Actions.
- Added focused component coverage for every field, parent-driven replacement, normalization, validation and focus order, keyboard submit, pending/read-only behavior, status announcements, and architectural boundaries.

### Changed Files

- Eight files changed under `app/`: the plan, two CRM locale catalogs, the Customer form, both existing Customer owner pages, and two CRM component-test files.
- Final totals: 8 files changed, 859 insertions, 99 deletions.

### Tests Written or Updated

- `verticals/crm/tests/components/customer-form.test.tsx` — covers all six controls, controlled parent replacement, complete change emissions, normalization, every client validation failure, focus, optional/equal-date cases, error clearing, duplicate submits, keyboard submit, pending/read-only/cancel behavior, accessible server feedback, responsive composition, and application-dependency absence.
- `verticals/crm/tests/components/customer-create-page.test.tsx` — updates the generated-boundary assertion for the controlled owner contract.

### Validation

- `mise exec -- pnpm --filter @app/crm test:component` — passed: 9 files and 193 tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed after removing the preview-generated, ignored router cache so the check reflected tracked source.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-customer-form-business-fields ULTRAMODERN_SOURCE_REVISION=433c46d5ff16fa057f2a372f80fbd9816ed5ba72 mise exec -- pnpm --filter @app/crm build` — passed the CRM client/server, manifest, public-surface, and deploy build with an immutable worktree source revision.
- `mise exec -- pnpm check` — passed the final repository quality gate.
- `mise exec -- pnpm --filter @app/crm dev` plus browser review — passed: the localized six-field form rendered at desktop and 390 px widths, the narrow page had no horizontal overflow, and the browser console reported no errors.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, the specification and dependency plan, `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `ULTRAMODERN.md`, `FRONTEND.md`, `MODULE_ENTRYPOINTS.md`, `MODULE_MANIFESTS.md`, and relevant V0 product context under `../docs/`.
- Reviewed `git status --short`, `git diff --check`, the complete task diff, tests, responsive behavior, accessibility, and owner/Action/BFF/Effect boundaries. No unresolved in-scope findings remain.
- Review screenshots: `.codex/reports/review/feature-crm-customer-form-business-fields/create-form-desktop.jpg` and `.codex/reports/review/feature-crm-customer-form-business-fields/create-form-narrow-viewport.jpg`.

### Deviations and Follow-ups

- The unqualified build first rejected the worktree-only default `workspace` source revision after compiling successfully. Re-running it with the immutable base revision above passed; no product-code workaround was introduced.
- Expanded create/edit mutation payloads, persistence, and ARES integration remain intentionally assigned to their dedicated specifications.
