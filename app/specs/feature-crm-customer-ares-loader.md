---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer ARES loader component

## Feature Description

Add an owner-private Customer presentation component containing exactly one IČO input and one lookup
button. It validates and emits a normalized IČO; its parent owns the generated BFF Effect, typed
errors, and returned Customer data.

## User Story

As a CRM user creating a Customer
I want a small ARES lookup control
So that I can request business data only after entering a valid IČO

## Problem Statement

The create page needs a reusable interaction surface, but frontend architecture prohibits reusable
presentation from fetching, executing Effects, receiving query objects, or decoding domain errors.
It must also avoid accidentally submitting the adjacent Customer form.

## Solution Statement

Create `CustomerAresLoader` inside the Customer feature. Compose UI-kit `FormInput`, `Button`, and
`StatusText`; keep local input/validation interaction only; emit `onLookup(ico)` once per valid user
intent; and receive pending/disabled/status state as plain props.

## Relevant Files

Use these files to implement the feature:

- `docs/frontend/FRONTEND.md` — reusable presentation and application-state boundaries.
- `verticals/crm/src/features/customers/customer-form.tsx` — owner-private form composition pattern.
- `verticals/crm/tests/components/customer-form.test.tsx` — Testing Library accessibility pattern.
- `verticals/crm/package.json` — existing UI-kit and component-test dependencies.

### New Files

- `verticals/crm/src/features/customers/customer-ares-loader.tsx` — approved owner-private presentation component.
- `verticals/crm/tests/components/customer-ares-loader.test.tsx` — validation, interaction, and accessibility tests.

## Implementation Plan

### Phase 1: Foundation

Define plain copy/status/callback props and an exact IČO normalization rule, without importing the
generated lookup client or Customer domain contract.

### Phase 2: Core Implementation

Compose one input, one button, inline validation, loading/disabled behavior, and keyboard submission
using existing UI-kit components.

### Phase 3: Integration

Prove the component can render as a sibling form next to `CustomerForm`, with all application and
result handling left to the future create-page owner.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the owner-private component contract

- [x] Create plain props for localized copy, pending/disabled state, optional presentation status, and semantic `onLookup(ico)`; do not accept BFF clients, Effects, query objects, Customer DTOs, or typed domain errors.
- [x] Keep the component private to CRM and out of manifests, Module Federation, Shell registration, and public-component scaffolding.

### 2. Implement IČO input and lookup action

- [x] Compose exactly one UI-kit `FormInput` and one primary `Button`, with a `StatusText` only for validation/lookup feedback.
- [x] Trim the input, preserve leading zeroes, require exactly eight ASCII digits, focus the invalid input, and emit one normalized value only when valid.

### 3. Preserve safe interaction behavior

- [x] Support Enter as lookup, disable repeat activation while pending/disabled, expose loading text and polite status, and keep the lookup submit boundary separate so it cannot submit `CustomerForm` or create nested forms.
- [x] Clear local format errors when the value changes and leave not-found/unavailable messages controlled by the parent.

### 4. Add focused component tests

- [x] Test valid click/Enter emission, leading zeroes, whitespace normalization, letters/wrong lengths, invalid focus, one emission per intent, pending/loading/disabled behavior, status announcement, accessible names/descriptions, and absence of BFF/fetch/application imports.
- [x] Add a composition test proving loader and Customer form can be sibling forms and the lookup action never triggers Customer creation.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve component-related failures only.

## Testing Strategy

### Unit Tests

Render with plain callbacks and test IČO validation, keyboard/pointer behavior, interaction guards,
accessible errors/status, and sibling-form isolation.

### Integration Tests

Not required here; the create-page integration spec owns the real generated BFF client and returned
data flow.

### Edge Cases

- IČO contains leading zeroes or surrounding whitespace.
- User double-clicks or presses Enter repeatedly while pending.
- Parent switches from an error status back to idle.

## Acceptance Criteria

- [x] The component contains one IČO input and one lookup button.
- [x] Only a valid normalized eight-digit IČO is emitted.
- [x] The component performs no fetch/BFF/Effect work and receives no domain errors.
- [x] Lookup cannot submit the Customer create form.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component` — validate loader interaction and accessibility.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate plain presentation props.
- `mise exec -- pnpm --filter @app/crm build` — compile the owner-private component.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends conceptually on `feature-crm-ares-lookup-bff.md`, but remains independently testable because it receives only presentation props and callbacks.
- The user explicitly approved this owner-private component; no new UI-kit component is required.

## Implementation Evidence

### Summary

- Added the approved owner-private `CustomerAresLoader` with localized plain props, exact ASCII IČO normalization, accessible validation, duplicate-intent protection, controlled pending/disabled/status presentation, and an isolated lookup form boundary.
- Kept all ARES client, Effect, typed error, Customer result, route, manifest, registration, and Module Federation concerns outside the component.

### Changed Files

3 files changed, 538 insertions(+), 0 deletions(-).

### Tests Written or Updated

- `verticals/crm/tests/components/customer-ares-loader.test.tsx` — proves the exact one-input/one-button contract, click and Enter normalization, leading zeroes, ASCII-only length validation, invalid focus/descriptions, local-error clearing, repeated click/Enter guards, rejection recovery, pending/disabled/loading presentation, parent status announcement/clearing, sibling-form isolation, and forbidden application dependencies.

### Validation

- `mise exec -- pnpm --filter @app/crm exec rstest tests/components/customer-ares-loader.test.tsx` — passed; 15 focused tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed; 200 tests across 10 component files.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm --filter @app/crm build` — compiled client/server bundles and passed TS-Go, then the expected release-envelope guard rejected dirty-worktree `sourceRevision "workspace"`.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-ares-loader-worktree ULTRAMODERN_SOURCE_REVISION=433c46d5ff16fa057f2a372f80fbd9816ed5ba72 mise exec -- pnpm --filter @app/crm build` — passed completely with immutable local validation metadata.
- `mise exec -- pnpm check` — passed after applying the repository formatter and one lint-requested test-key ordering fix.
- Browser validation — not run because this specification intentionally creates an unintegrated owner-private presentation component with no route or runtime surface; component interaction and accessibility were validated through RSTest/Testing Library instead.

### Review

- Re-read and reviewed the complete change against `../AGENTS.md`, `AGENTS.md`, the full specification, MicroVertical, Action, Effect error, module-entrypoint, module-manifest, UltraModern, frontend, relevant repository product architecture, and installed UI-kit 0.25.1 component contracts and adoption guidance.
- Confirmed the component uses exactly one UI-kit `FormInput`, one primary UI-kit `Button`, and feedback-only `StatusText`; uses only layout Tailwind classes; receives localized copy and plain view state; and has no native primitive, plain CSS, token override, wrapper, application hook, backend import, public entrypoint, or cross-MicroVertical dependency.
- No Codesmith generator applies: the specification explicitly approves an owner-private presentation component and forbids the public-component/page/Action surfaces that available generators create.
- Review found missing direct coverage for repeated Enter and rejected-callback guard release; added both tests and reran the focused suite, full component suite, typecheck, and repository quality gate successfully.

### Deviations and Follow-ups

- A fresh-worktree CRM typecheck initially lacked referenced package declaration outputs. Building the project-reference dependencies exposed an unrelated Shell generated-Module-Federation declaration prerequisite; after the dependency declarations existed, the exact CRM typecheck and final repository gate passed.
- The literal dirty-worktree build is intentionally non-promotable; the identical build passed with the immutable base revision supplied as validation metadata. No implementation deviation or follow-up remains.
