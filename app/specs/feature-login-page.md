---
type: feature
status: done
created: 2026-07-29
---

# Feature: Login Page

## Feature Description

Add a shell-owned login page at `/login` with Login and Password fields and one
primary button whose English text is `Login`. Submitting the form validates on
the client that both fields are filled. If either field is missing, the page
marks the relevant UI-kit field as invalid and shows one UI-kit error Toast.

This feature establishes the pre-authentication user interface only. It does
not authenticate credentials, create a session, resolve an OntOS principal, or
navigate after a valid submission.

## User Story

As a user entering OntOS
I want to provide my login and password and receive clear validation feedback
So that I know when the required credentials are missing before authentication

## Problem Statement

The shell currently has only its localized home route and provides no login
form. OntOS product architecture assigns authentication and identity to
Shell/Core, but there is not yet an application route where a user can enter
credentials. The requested scope defines only client validation and error
feedback; the BetterAuth submission and authenticated-principal session flow
are not yet implemented.

## Solution Statement

Create a private, non-indexable localized shell route backed by one page-owned
React component. Compose the form from the installed
`@techsio/ui-kit@0.25.1` `FormInput`, `Button`, `Toaster`, and `useToast` APIs.
Use one semantic form-submit handler for both button activation and Enter-key
submission. The handler recomputes missing fields, exposes field-level error
state, focuses the first invalid field, and creates one transient error Toast.

Keep all app-authored text in the existing English and Czech shell locale
resources. Mount the Toast portal once in the shell layout. Do not add a BFF
client, Action, authentication request, loading state, or success transition
until the real BetterAuth contract is separately specified.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory Codesmith generator rules.
- `AGENTS.md` — authoritative application architecture and managed command
  convention.
- `README.md` — shell ownership, private-first route metadata, localization,
  and generated route behavior.
- `docs/architecture/ULTRAMODERN.md` — generator and direct-file-creation
  constraints.
- `docs/frontend/FRONTEND.md` — UI-kit, component, state, accessibility, and
  frontend integration rules.
- `../docs/09_AUTHN_AUTHZ_MODEL.md` — BetterAuth and Core identity ownership;
  prevents this UI-only plan from inventing authentication behavior.
- `../docs/adr/0014-authenticated-principal-session.md` — defines the
  authenticated OntOS state that remains outside this feature.
- `apps/shell-super-app/src/routes/layout.tsx` — shell-global location for one
  UI-kit `Toaster`.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — closest localized page
  implementation pattern.
- `apps/shell-super-app/src/routes/[lang]/route.meta.ts` — closest private,
  non-indexable route metadata pattern.
- `apps/shell-super-app/src/routes/ultramodern-route-metadata.ts` — generated
  route metadata manifest; regenerate rather than edit it manually.
- `apps/shell-super-app/src/modern-tanstack/index/router.gen.ts` — generated
  TanStack route tree; regenerate rather than edit it manually.
- `apps/shell-super-app/src/modern.runtime.ts` — existing shell i18n namespace
  and English/Czech resource registration.
- `apps/shell-super-app/locales/en/shell.json` — English login labels,
  validation feedback, Toast content, and route metadata text.
- `apps/shell-super-app/locales/cs/shell.json` — matching Czech translations.
- `apps/shell-super-app/package.json` — installed UI-kit version and focused
  shell typecheck command.
- `scripts/generate-tanstack-routes.mts` — repository-managed route generator.
- `package.json` — supported validation scripts.

### New Files

- `apps/shell-super-app/src/routes/[lang]/login/page.tsx` — page-owned UI-kit
  login form and client validation integration.
- `apps/shell-super-app/src/routes/[lang]/login/route.meta.ts` — private,
  non-indexable login route metadata.
- `apps/shell-super-app/rstest.config.ts` — Modern.js-aware Rstest
  configuration for unit and component tests using `happy-dom`.
- `apps/shell-super-app/tests/unit/routes/login/page.test.tsx` — focused
  component tests for login validation and interaction behavior.
- `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` — English and
  Czech login translation parity coverage.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — shell-global Toast
  renderer coverage.
- `apps/shell-super-app/playwright.config.ts` — Playwright configuration for
  shell end-to-end tests against the built application.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — localized login-route and
  browser-interaction coverage.

## Implementation Plan

### Phase 1: Foundation

Confirm the shell owns this system-level authentication entry point and record
that the MicroVertical page generator does not apply. Establish the approved
Modern.js testing baseline: Rstest for unit/component tests and Playwright for
end-to-end tests. Define private route metadata and translated content using
the existing shell patterns.

### Phase 2: Core Implementation

Mount the global UI-kit Toast renderer and compose the login form from
`FormInput` and `Button`. Add page-local validation state and one submit path
that handles mouse and keyboard submission, field errors, focus, and Toast
feedback. Add automated validation and interaction tests using the approved
test harness under the shell package's `tests/` directory.

### Phase 3: Integration

Regenerate the framework-owned route files, verify localized route behavior
and accessibility in the browser, and run the shell and repository validation
commands. Confirm the implementation stays client-only and does not cross the
Action, BFF, Effect error, session, or principal boundaries.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Resolve ownership, scaffolding, and test prerequisites

- [x] Confirm the login page remains a Shell/Core system capability rather
      than a MicroVertical business page. Do not run
      `scaffold:microvertical-page` or invent a placeholder vertical.
- [x] Treat approval of this plan as approval for one page-owned route
      component composed from existing UI-kit components; do not introduce a
      reusable application component.
- [x] Treat approval of this plan as explicit developer authorization to
      create `apps/shell-super-app/src/routes/[lang]/login/page.tsx` and
      `apps/shell-super-app/src/routes/[lang]/login/route.meta.ts` directly.
      These are shell-owned business files for which no applicable Codesmith
      generator exists.
- [x] Add the approved light testing baseline to
      `apps/shell-super-app/package.json`: Rstest with the Modern.js adapter,
      `happy-dom`, and Testing Library for unit/component tests, plus Playwright
      for end-to-end tests. The expected development dependencies are
      `@rstest/core`, `@modern-js/adapter-rstest`, `happy-dom`,
      `@testing-library/react`, `@testing-library/dom`,
      `@testing-library/user-event`, and `@playwright/test`. Select versions
      compatible with the installed Modern.js package cohort and update the
      pnpm lockfile.
- [x] Add `"test:unit": "rstest"` and
      `"test:e2e": "playwright test"` scripts to the shell package. Configure
      Rstest in `apps/shell-super-app/rstest.config.ts` with
      `withModernConfig()` and `testEnvironment: "happy-dom"`. Configure
      Playwright in `apps/shell-super-app/playwright.config.ts` to run the
      shell's built application and use Chromium as the minimum browser target.
      Install the Playwright Chromium binary through the repository-managed
      toolchain before executing the E2E suite.

### 2. Define the private localized login route

- [x] Add
      `apps/shell-super-app/src/routes/[lang]/login/route.meta.ts` following
      the existing route metadata shape with id `shell-login`, canonical path
      `/login`, owner `shell-super-app`, namespace `shell`,
      `public: false`, `indexable: false`, and
      `publicSurface: "private-app-screen"`.
- [x] Use localized title and description keys and the same `/login` localized
      path for English and Czech. Keep the route reachable before
      authentication even though it is private and non-indexable for public
      discovery.
- [x] Add router/metadata generation assertions in the approved test harness
      when that harness supports generated-route checks; otherwise cover route
      registration in the runtime test for this step.

### 3. Add localized login content

- [x] Add structurally matching `shell.login.*` keys to
      `apps/shell-super-app/locales/en/shell.json` and
      `apps/shell-super-app/locales/cs/shell.json` for the page title, Login
      and Password labels, submit text, required-field messages, Toast title,
      Toast description, and route description.
- [x] Set the English submit translation to exactly `Login`; use the approved
      Czech equivalent for the Czech route.
- [x] Add or update locale-contract tests using the approved harness so
      missing or mismatched login keys fail deterministically.

### 4. Mount the global UI-kit Toast renderer

- [x] Update `apps/shell-super-app/src/routes/layout.tsx` to render exactly one
      `Toaster` from `@techsio/ui-kit/molecules/toast` alongside the route
      outlet.
- [x] Add a layout/component test in the approved harness proving the Toast
      portal is available once and is not mounted inside the login form or
      submit button.

### 5. Implement the UI-kit login form and client validation

- [x] Add
      `apps/shell-super-app/src/routes/[lang]/login/page.tsx` as the single
      page-owned component and obtain strings through the existing
      `useModernI18n` integration.
- [x] Render a semantic `<form noValidate>` containing: - a required `FormInput` with label `Login`, stable id/name,
      `type="text"`, and `autoComplete="username"`; - a required `FormInput` with label `Password`, stable id/name,
      `type="password"`, and `autoComplete="current-password"`; and - one `Button` with `type="submit"`, `variant="primary"`,
      `theme="solid"`, and translated text.
- [x] Use UI-kit component props and tokens for control visuals. Use Tailwind
      only for responsive page layout; add no plain CSS, native input/button
      replacement, custom Toast, or duplicated UI-kit control styling.
- [x] In the single form-submit handler, prevent default submission and
      recompute validity from current values. Treat Login as missing when it
      is empty after trimming; treat Password as missing only when its value
      length is zero so non-empty password whitespace is not altered.
- [x] Map each missing field to `validateStatus="error"` and localized
      `helpText`, return corrected fields to the default state on the next
      submission, and focus the first missing field.
- [x] When one or both fields are missing, call `useToast().create(...)` once
      with `type: "error"` and short localized title/description content.
- [x] When both fields are filled, clear stale validation and perform no
      request, navigation, success Toast, loading state, session change, or
      other side effect.
- [x] Add focused tests in the approved harness for both fields missing, each
      individual field missing, both fields present, correction after a prior
      error, one Toast per invalid submit, Enter-key submission, and first
      invalid-field focus. The valid-submission test must explicitly assert
      that no validation Toast, network request, or navigation occurs.

### 6. Regenerate and verify route integration

- [x] Run the repository route generator and review the generated changes in
      `ultramodern-route-metadata.ts` and `router.gen.ts`; do not hand-edit
      either file.
- [x] Verify `/login` follows the existing locale redirect behavior and that
      `/en/login` and `/cs/login` render their corresponding translations.
- [x] Verify the page at mobile and desktop widths, keyboard-only submission,
      visible field validation, focus placement, and Toast feedback.
- [x] Verify a valid submission produces no browser network request and no
      navigation.

### 7. Run all validation commands

- [x] Execute every command listed under Validation Commands in order and fix
      all failures without weakening repository gates or expanding feature
      scope.

## Testing Strategy

### Unit Tests

Use Rstest with `@modern-js/adapter-rstest`, `happy-dom`, and Testing Library.
Add focused tests for the required-field decision table and for the component's
field status, help text, Toast creation count, keyboard submission,
stale-error clearing, focus behavior, and valid-submission absence of Toast,
network, and navigation side effects. Keep shell-owned tests under
`apps/shell-super-app/tests/unit/`; do not add a general validation abstraction
solely to make the tests easier.

### Integration Tests

Use Playwright for automated end-to-end coverage of `/login`, `/en/login`, and
`/cs/login`. Confirm the generated router recognizes the page, locale content
is correct, the form is usable with keyboard and mobile viewport widths,
invalid submissions show field feedback plus one Toast, and valid submissions
cause no request or redirect. Retain implementation-time browser review as
additional evidence rather than a substitute for the Playwright suite.

Loading, empty, forbidden, conflict, and retry states are not required because
this feature performs no asynchronous or backend operation.

### Edge Cases

- Both fields are empty.
- Only Login is empty.
- Login contains only whitespace.
- Only Password is empty.
- Password contains non-empty whitespace that must not be trimmed or changed.
- A corrected field clears its previous error on the next submit.
- Repeated invalid submissions create one Toast per submission, not one per
  invalid field.
- Enter-key submission follows the same path as activating the button.
- Locale changes do not leave stale English validation content on the Czech
  route.

## Acceptance Criteria

- [x] `/login` resolves through the shell's existing locale behavior;
      `/en/login` renders English and `/cs/login` renders Czech.
- [x] The English page displays UI-kit fields labeled `Login` and `Password`
      and exactly one UI-kit button with the text `Login`.
- [x] The Czech page displays the corresponding Czech translations.
- [x] Submitting with both fields empty marks both fields invalid, focuses
      Login, and shows exactly one UI-kit error Toast.
- [x] Submitting with only one field empty marks and focuses only that field
      and shows exactly one UI-kit error Toast.
- [x] Submitting after correcting a field clears that field's stale error.
- [x] Submitting with both fields filled clears validation, shows no error
      Toast, sends no network request, and does not navigate.
- [x] Activating the Login button and pressing Enter run the same validation.
- [x] The page uses `FormInput`, `Button`, `Toaster`, and `useToast` from the
      installed UI kit without recreating those components or styles.
- [x] The login route is private and non-indexable but remains accessible
      before authentication.
- [x] Automated tests cover the validation decision table, Toast behavior,
      keyboard submission, stale-error clearing, and focus behavior using the
      approved frontend test harness.
- [x] The Rstest unit/component suite and Playwright E2E suite both pass, and
      the Playwright suite covers the localized routes, invalid interaction,
      and valid submission without a request or navigation.
- [x] The page remains usable and legible at mobile and desktop widths.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec node ./scripts/generate-tanstack-routes.mts` —
  regenerate framework-owned route files.
- `mise exec -- pnpm --filter @app/shell-super-app typecheck` — typecheck the
  affected shell application.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run Rstest
  unit/component coverage for login validation and shell Toast integration.
- `mise exec -- pnpm i18n:boundaries` — validate localization boundaries and
  shell locale integration.
- `mise exec -- pnpm contract:check` — validate route metadata, topology, and
  generated workspace contracts.
- `mise exec -- pnpm check` — Run the final repository quality gate.
- `mise exec -- pnpm build` — compile the shell and verify generated Module
  Federation and performance-readiness outputs.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — run the
  Playwright login suite against the built shell application.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant
      referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error
      boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Implemented the localized shell login route, UI-kit form controls, field
  validation, global Toast host, generated route metadata, and focused test
  harnesses.
- Moved shell-owned tests into `apps/shell-super-app/tests/unit/` and
  `apps/shell-super-app/tests/e2e/`.
- Updated the OntOS implementation skill to require package-owned `tests/`
  directories for shells, MicroVerticals, and shared packages.

### Changed Files

- 22 files changed, approximately 1,559 insertions and 20 deletions, including
  the untracked implementation, test, configuration, and specification files.

### Tests Written or Updated

- `apps/shell-super-app/tests/unit/routes/login/page.test.tsx` — required-field
  decision table, repeated Toasts, keyboard submission, focus, stale-error
  clearing, and valid-submit side effects.
- `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` — locale
  contract parity and generated login metadata.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — one shell-global Toast
  host.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — English/Czech routes and
  metadata, localized invalid states, redirect behavior, valid/invalid
  interactions, and mobile usability.

### Validation

- `mise exec -- pnpm exec node ./scripts/generate-tanstack-routes.mts` — passed.
- `mise exec -- pnpm --filter @app/shell-super-app typecheck` — passed after
  removing the redundant explicit i18next instance.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed: 3 files,
  13 tests.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm contract:check` — passed after registering the Rstest
  adapter in package-source cohort metadata.
- `mise exec -- pnpm check` — passed after formatting the two architecture
  tables and resolving the feature-file lint findings it exposed.
- `mise exec -- pnpm build` — passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — passed: 7
  Chromium tests.
- `git diff --check` — passed.

### Review

- Reviewed both applicable `AGENTS.md` files plus the MicroVertical, Action,
  Effect error, UltraModern, frontend, authentication, and principal-session
  guidance.
- Independent Standards and Spec reviews found metadata integration, raw
  visual tokens, repeated-submit coverage, and Czech invalid-state coverage;
  all four feature findings were fixed.
- UI-kit audit found no native control replacements or recreated UI-kit
  components. Production browser review verified field focus and one localized
  error Toast.
- Screenshot:
  `.codex/reports/review/feature-login-page/login-en-validation-final.png`.

### Deviations and Follow-ups

- The standalone typecheck and final repository quality gate now pass.
- Shell Tailwind utilities remain unprefixed because the current UI-kit token
  import pipeline fails when Tailwind's `prefix(shell)` is enabled. This is
  CSS-federation technical debt.
- The route generator now covers the generated login manifest through the
  shell unit test, but its new generic discovery/filtering/error paths do not
  yet have isolated tooling tests.
- Rstest passes with a non-blocking `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Notes

- Approval of this plan selects and authorizes the shell testing baseline:
  Rstest with the official Modern.js adapter, `happy-dom`, and Testing Library
  for unit/component tests, and Playwright for end-to-end tests. The
  implementation may add the compatible development dependencies,
  configuration files, package scripts, test files, Chromium browser
  installation, and pnpm lockfile changes required to run both suites.
- Approving this plan also approves the component strategy: one page-owned
  route component composed from existing UI-kit components, with no new
  reusable component and no UI-kit library changes.
- Approval also explicitly authorizes direct creation of
  `apps/shell-super-app/src/routes/[lang]/login/page.tsx` and
  `apps/shell-super-app/src/routes/[lang]/login/route.meta.ts` because these
  shell-owned business files have no applicable Codesmith generator.
- No Codesmith generator applies because this is a Shell/Core system route,
  not a MicroVertical page, Action, Outbox Message, or Policy. If ownership
  changes to a MicroVertical, implementation must stop, identify the approved
  owning vertical, and run the mandatory `scaffold:microvertical-page`
  generator for that vertical and the `login` page before adapting generated
  output.
- Product architecture proposes BetterAuth for login/session mechanics and
  requires a BetterAuth session to resolve through an active principal binding,
  principal, and tenant before OntOS considers the user logged in. That
  workflow requires a separate specification.
- The installed Toast component owns a hard-coded English accessible label for
  its close control and exposes no localization prop. App-authored strings are
  localized here; translating that library-owned label requires a separate
  UI-kit API change.
- The UI-kit usage skills describe an older library version, so implementation
  must continue to treat the installed `@techsio/ui-kit@0.25.1` declarations as
  the API source of truth.
