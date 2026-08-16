---
type: feature
status: done
created: 2026-08-16
---

# Feature: CRM Customer create page

## Feature Description

Add the generated CRM `CustomerCreate` page at localized URL
`/cs/crm/customers/:id/new` (canonical generator URL `/crm/customers/:id/new`, also exposed under
`/en`). The authenticated Shell continues to own dashboard/sidebar composition, legal-entity
selection, exact page resolution, module-state gating, and the lazy remote load. The CRM-owned page
renders the existing owner-private `CustomerForm` with empty initial values and submits the valid
name through the generated `createCustomer` Effect client method. That BFF endpoint must execute the
existing `CreateCustomerAction`; the page must not call the Action handler, persistence service, or
HTTP endpoint directly.

Use Figma file `ERP`, page `Pre-Alpha Repo` (not `Pre-Alpha`), frame
`Resource Detail — Běžný` (`6:780`) only as an arrangement wireframe. Preserve the authenticated
Shell, compact Back link, page heading, and one main content surface, but replace the read-only
detail rows with the form controls. Do not copy Figma styling or add its inert Overview/Documents/
Timeline/Audit tabs. Use the existing `@techsio/ui-kit` components and tokens, with CRM-prefixed
Tailwind utilities only for responsive layout composition.

The generated route carries the declared `id` parameter through the Shell boundary because the
requested URL contains it. The current `CreateCustomerPayloadSchema` accepts only `name`, so this
feature treats `id` as untrusted navigation context and never sends it to `createCustomer`, derives
trusted context from it, or changes the Action contract to accommodate it.

## User Story

As an authenticated CRM user with write access
I want to enter a new Customer name on a dedicated localized page
So that I can create the canonical Customer through the governed CRM Action boundary

## Problem Statement

CRM already owns Customer persistence, `CreateCustomerAction`, the strict Effect BFF mutation, and
the generated `createCustomer` client, but there is no governed page where a user can create a
Customer. Calling the endpoint directly would bypass the intended frontend integration and would
provide no accessible validation, pending, denial, retry, or localized success/failure experience.
The requested dynamic route also requires Codesmith-owned manifest, registration, federation,
Shell connector, route-parameter, and locale wiring before business UI can be adapted safely.

## Solution Statement

Run the mandatory MicroVertical page generator with stable identity `customer-create` and canonical
URL `/crm/customers/:id/new`. Preserve its private/non-indexable exact-page descriptor, dynamic
non-navigation behavior, owner-private registration, Module Federation exposure, approved Shell
lazy client, and bounded `id` propagation. Adapt the generated CRM page and federation wrapper to
receive the resolved target so write availability remains explicit.

Reuse `verticals/crm/src/features/customers/customer-form.tsx` unchanged with
`initialValues={{ name: '' }}` and create-specific localized copy. Keep route, BFF, query, Effect,
permission, and navigation behavior in the generated page integration. Use the existing page-local
TanStack Query mutation pattern to bridge the generated `createCustomer` Effect at the framework
edge, retain its operation-specific typed error union, and map every expected failure into the
form's existing field/form status contract. Generate one idempotency key per logical submission,
reuse it only after an uncertain same-name failure, and replace it after the user changes the
intent. On success, navigate to the localized generated Customers list.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — `app/`-only scope and mandatory MicroVertical page generator rule.
- `AGENTS.md` — authoritative MicroVertical, Action, BFF, Effect error, module-entrypoint, frontend, Figma, and toolchain constraints.
- `README.md` — dynamic page URL grammar, localized route ownership, strict Effect BFF topology, and supported validation commands.
- `docs/architecture/MICROVERTICALS.md` — generated CRM BFF client seam and prohibition on frontend backend imports or ad hoc fetches.
- `docs/architecture/ACTIONS.md` — required Action lifecycle, idempotency, trusted context, and typed failure behavior.
- `docs/architecture/ERRORS.md` — operation-specific typed client errors and exhaustive UI mapping.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact dynamic-page resolution, bounded route params, write availability, and lazy private load ordering.
- `docs/architecture/MODULE_MANIFESTS.md` — generator-owned page identity, manifest/registration slots, and dynamic non-navigation rules.
- `docs/architecture/ULTRAMODERN.md` — Codesmith-first business artifacts and Effect-first feature integration.
- `docs/frontend/FRONTEND.md` — route/presentation separation, UI-kit reuse, i18n, explicit states, accessibility, and responsive behavior.
- `docs/frontend/FIGMA.md` — Figma is arrangement-only and must not replace UI-kit visuals.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory generator that creates all initial owner/Shell page files and patches governed wiring atomically.
- `specs/feature-crm-customer-contact-actions.md` — implemented owner of `CreateCustomerAction`, its payload/result, strict BFF mapping, generated client, identity gateway, and real integration coverage.
- `specs/feature-crm-customer-edit-page.md` — implemented precedent for dynamic Customer route wiring, `CustomerForm`, target writability, mutation idempotency, typed UI states, and localized navigation.
- `verticals/crm/package.json` — existing UI-kit, TanStack Query, component-test, typecheck, integration-test, and build setup to reuse without dependency changes.
- `verticals/crm/src/features/customers/customer-form.tsx` — existing owner-private presentation component required by this feature.
- `verticals/crm/tests/components/customer-form.test.tsx` — existing proof that the form supports empty create values, validation, pending/disabled state, errors, and presentation-only ownership.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — closest owner-side mutation, idempotency, target-writability, error-mapping, and navigation precedent.
- `verticals/crm/src/api/crm-client.ts` — generated `createCustomer` Effect client method that the page must call exclusively.
- `verticals/crm/shared/api.ts` — canonical mutation input, result, headers, and declared public Problem Details schemas.
- `verticals/crm/src/actions/create-customer.action.ts` — existing generated Action descriptor and handler registration reached by the BFF, not imported by UI.
- `verticals/crm/api/index.ts` — existing strict BFF handler that maps `createCustomer` to `createCustomerAction`.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — real contract-derived client-to-BFF proof for Customer creation and typed failures.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — real Action runtime, persistence, idempotency, evidence, and tenant-isolation proof.
- `verticals/crm/locales/cs/crm.json` — Czech create-page, form, mutation, state, and navigation copy.
- `verticals/crm/locales/en/crm.json` — English counterpart with an identical key structure.
- `verticals/crm/vertical.manifest.ts` — generated private page component and exact page contribution slots.
- `verticals/crm/vertical.registration.ts` — generated owner-private lazy page registration.
- `verticals/crm/module-federation.config.ts` — generated `PageCustomerCreate` exposure.
- `verticals/crm/src/routes/ultramodern-route-metadata.ts` — generated compatibility metadata to verify after adding the owner route.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated approved `PageCustomerCreate` lazy-client entry.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic exact-target loader and bounded declared-route-param selection.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell wrapper that passes route params and resolved target only after the remote is approved.
- `apps/shell-super-app/src/routes/ultramodern-route-metadata.ts` — generated Shell compatibility metadata to verify after adding the connector route.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — Shell exact-target and route-parameter propagation coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — lazy remote ordering and resolved target/route-param prop coverage.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/new/page.tsx` — generated `CustomerCreatePage`, then adapted for form composition, target writability, typed BFF mutation orchestration, and localized navigation.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/new/route.meta.ts` — generated private/non-indexable dynamic owner route metadata.
- `verticals/crm/src/federation/page-customer-create.tsx` — generated localized Module Federation wrapper, adapted to pass the resolved target and route params.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/new/page.tsx` — generated authenticated Shell connector.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/new/page.data.ts` — generated exact-target loader carrying only the declared bounded `id` parameter.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/new/route.meta.ts` — generated private Shell route metadata.
- `verticals/crm/tests/components/customer-create-page.test.tsx` — create-form integration, BFF payload, idempotency, error-state, accessibility, navigation, and generated-boundary coverage.

## Implementation Plan

### Phase 1: Foundation

Generate the exact dynamic page and all owner/Shell wiring before adapting business code. Verify the
generator retains the canonical route without a locale prefix, carries only `id`, omits dynamic
navigation, and creates stable `customer-create` identities. Reuse the already implemented Customer
Action/BFF and CRM UI/query/test infrastructure; add no backend contract, persistence, dependency,
or UI-kit component.

### Phase 2: Core Implementation

Adapt the generated remote page and federation wrapper to receive `target.writable`. Render the
existing `CustomerForm` with empty values and create-specific localized copy. Compose
`createCustomer` through a typed TanStack mutation, preserve all generated client failure families,
and implement logical-submission idempotency without leaking route context into the Action payload.
Add focused tests beside the writable, form, mutation, error, and navigation behavior.

### Phase 3: Integration

Complete Czech/English copy, generated manifest/registration/federation/Shell verification,
responsive and keyboard behavior, and exact route-param tests. Use the existing real CRM integration
suites as the proof that the client call reaches `CreateCustomerAction` through the strict BFF and
commits under the governed Action lifecycle. Finish with the independent CRM build, Shell unit
suite, repository boundary checks, and final quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the CustomerCreate page and governed wiring

- [x] From `app/`, make the first implementation change by running `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customer-create --url /crm/customers/:id/new`; do not create the initial route, metadata, federation, manifest, registration, locale, approved-client, or Shell connector files by hand.
- [x] Inspect the complete generated mutation set. Retain `CustomerCreatePage`, `page-customer-create`, `crm.core.page.customer-create`, canonical `/crm/customers/:id/new`, `[lang]/crm/customers/[id]/new` filesystem routing, private/non-indexable metadata, tenant `page`/`read` ownership, exact Shell connector, and no ordinary navigation contribution.
- [x] Verify generated owner and Shell compatibility route metadata, manifest component/page slots, owner-private registration, `./PageCustomerCreate` exposure, and approved Shell lazy-client identity agree exactly; extend existing generated contract assertions only if the new output is not already covered generically.

### 2. Preserve resolved target and route-parameter boundaries

- [x] Adapt the generated owner page props and `page-customer-create.tsx` federation wrapper using the established CustomerEdit pattern so the Shell-supplied `target.writable` and declared `routeParams.id` reach the owner page only after exact target resolution.
- [x] Keep `routeParams.id` separate from the form and mutation. Do not decode it as a Customer ID, load an existing Customer, add it to `CreateCustomerPayloadSchema`, use it as tenant/legal-entity/principal context, or include it in idempotency hashing; the current create contract remains `{ name }` plus trusted gateway context.
- [x] Add/extend Shell unit assertions proving the generated connector selects only `id`, bounds it through `selectRouteParams`, resolves `crm.core.page.customer-create` before lazy loading, and passes both route params and the resolved target to the approved remote.

### 3. Compose and test the existing CustomerForm for create

- [x] In the generated page integration, render the existing `CustomerForm` with `initialValues={{ name: '' }}`, create-specific localized labels, semantic `onSubmit`/`onCancel`, pending/disabled state, optional name error, and form status. Do not fork, wrap, publish, or duplicate the form component.
- [x] Preserve `CustomerForm`'s current normalization, required-name validation, invalid-field focus, Enter submission, duplicate-submit guard, accessible error relationships, polite status output, and responsive action layout. Change the component only if a failing create-page test proves a reusable contract defect, and keep any such change backward compatible with CustomerEdit.
- [x] Follow the `Pre-Alpha Repo` / `Resource Detail — Běžný` arrangement with a localized Back-to-Customers link, create heading/description, and the form replacing the read-only detail rows. Keep Shell chrome outside CRM, omit inactive tabs, use UI-kit defaults/tokens, and support narrow mobile through desktop widths.
- [x] When `target.writable` is false, show a localized read-only/forbidden explanation and render no enabled submit path. The initial empty form is the intentional ready state, not an empty-data error; submission pending is the page's loading state.
- [x] Add focused component tests for empty initial values, localized create labels, required-name validation/focus, keyboard submission, Cancel/Back without mutation, pending controls, `target.writable` gating, no Customer-detail query, and reuse of the existing presentation component.

### 4. Submit CreateCustomerAction through the generated CRM BFF client

- [x] Use `useMutation` inside the generated page's stable page-local `QueryClientProvider`, following the existing CustomerEdit pattern. Its mutation function must execute only `createCustomer({ name }, { baseUrl, correlationId, idempotencyKey, locale })` through `runEffectRequest`; do not use `fetch`, import `api/index.ts`, the Action, persistence, or another client wrapper.
- [x] Keep the exact `Effect.Error<ReturnType<typeof createCustomer>>` union at the mutation boundary and map it exhaustively: invalid request to the name field; authentication expiry and definite forbidden denial to form errors; idempotency/precondition conflict to a warning; transport, decode, declared `503`, and gateway unavailability to retryable uncertain state; and declared/sanitized internal failures to a non-sensitive generic error.
- [x] Generate one idempotency key for a new logical `{ name }` submission. Reuse it only after an uncertain failure when the normalized name is unchanged; create a new key after the user edits the name or after any definite terminal failure. Generate a fresh correlation ID for every network attempt.
- [x] On success, clear the logical attempt, expose localized success through the existing form-status contract, and navigate with the localized router to `/${language}/crm/customers`. Do not fabricate a Customer-detail destination because that generated page is not implemented; the list page will perform its normal fresh BFF query after navigation.
- [x] Add page tests proving exact normalized payload/options, absence of route `id` in the payload, one semantic mutation per submit, same-key uncertain retry, changed-intent key renewal, full typed error classification, no navigation on failure, and localized list navigation on success.

### 5. Complete i18n, accessibility, and generated-boundary coverage

- [x] Replace generator starter copy under `crm.pages.customerCreate` in both CRM catalogs with matching structures for title, description, Back, form labels/actions, validation, pending, read-only/forbidden, authentication, conflict, unavailable/retry guidance, generic failure, and success. Keep every visible and accessibility string out of TSX/configuration.
- [x] Keep owner and Shell route metadata private and non-indexable. Verify Czech runtime URL `/cs/crm/customers/:id/new`, English runtime URL `/en/crm/customers/:id/new`, and canonical generator route `/crm/customers/:id/new` without adding a locale to the manifest or route template.
- [x] Add locale-parity and architecture assertions proving `CustomerForm` remains owner-private, the page imports only the frontend CRM client seam, no direct `fetch`/backend/persistence import exists, the dynamic page is absent from navigation, and the generated owner/Shell/federation identities remain exact.
- [x] Reuse the existing CRM BFF/Action integration tests as the authoritative cross-boundary proof and extend them only if the page reveals an uncovered contract behavior. Do not replace real BFF proof with a page test mock or add a Shell-only browser test that cannot start the independently deployable CRM remote/BFF.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve feature-related failures without changing the CreateCustomer Action/API contract, adding Customer fields, creating a second form, introducing new UI-kit components or token overrides, weakening exact page gating, or modifying unrelated CRM behavior.

## Testing Strategy

### Unit Tests

Use the existing CRM Node unit tests for the Action/API descriptors and add Rstest/Testing Library
coverage for the generated CustomerCreate page. Mock only the generated frontend Effect client seam
in page tests. Prove empty-form composition, validation/focus/keyboard behavior, writable gating,
exact `createCustomer` payload/options, typed failure mapping, logical idempotency, accessible status,
localized navigation, route-param non-propagation to business input, and absence of forbidden
frontend dependencies. Retain the existing `CustomerForm` tests as the reusable presentation proof.

### Integration Tests

Run the existing CRM integration suites that execute Customer creation through both the generated
contract-derived client/BFF and the real Action runtime. They prove assertion verification,
`CreateCustomerAction` dispatch, idempotency, tenant/module/write scope, persistence, audit evidence,
typed Problem Details decoding, and rollback/isolation without weakening the MicroVertical seam.
Run Shell unit tests for exact page resolution, bounded `id` propagation, and lazy remote props. A
new Playwright test is not required because the current repository browser server does not
orchestrate both independently deployable Shell and CRM services.

### Edge Cases

- The route `id` is absent, overlong, or unusual but never becomes Customer creation input or trusted context.
- CRM is active and writable, read-only/deprecated, definitely denied, or its target resolution is unavailable.
- The Customer name is empty, whitespace-only, padded, at the schema length boundary, or edited after an uncertain submission.
- Submit is triggered by keyboard, double click, or repeated activation while pending.
- Authentication expires, permission is denied, idempotency/precondition conflicts, the BFF is unavailable, transport fails, or the response cannot be decoded.
- An uncertain same-name retry reuses its key; a changed name or definite failure starts a new logical attempt.
- Success navigation, Back, and Cancel preserve the active locale; Back/Cancel never invoke the Action.
- The form remains usable with keyboard and assistive technology and at narrow mobile and desktop widths.

## Acceptance Criteria

- [x] The generated private page resolves at `/cs/crm/customers/:id/new` and `/en/crm/customers/:id/new`, with canonical generator URL `/crm/customers/:id/new`, only after authenticated exact-page gating.
- [x] The page is registered in CRM manifest/registration/federation and the approved Shell client, remains private/non-indexable, and is not emitted as an ordinary navigation link.
- [x] The `Pre-Alpha Repo` / `Resource Detail — Běžný` arrangement is recognizable through the Back link, heading, and main form surface without copied Figma styling or inert tabs.
- [x] The existing owner-private `CustomerForm` is reused with empty initial values and no duplicated form component or new UI-kit primitive.
- [x] `routeParams.id` is bounded and passed only as generated route context; it is never sent to `createCustomer`, treated as trusted context, or used to change the Action/API contract.
- [x] A valid submit calls the generated `createCustomer` Effect client, whose existing BFF handler invokes `CreateCustomerAction`; no direct fetch, backend import, persistence access, or Action import exists in the page.
- [x] Logical submissions use correct idempotency semantics: same-key retry only after uncertain same-name failure, new key after changed intent, and fresh correlation per attempt.
- [x] Invalid name, pending, authentication, forbidden/read-only, conflict, unavailable/retryable, decode, generic failure, and success behavior are explicit, localized, accessible, and covered by tests.
- [x] A non-writable resolved target exposes no enabled mutation path.
- [x] Successful creation navigates to the localized Customers list; Back and Cancel navigate there without mutation.
- [x] Czech and English catalogs have matching `customerCreate` keys and no user-facing string is hardcoded in application TSX.
- [x] Focused page tests and the existing real CRM BFF/Action integration suites prove both frontend behavior and governed Customer creation without weakening deployment seams.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate existing Customer Action/API schemas, exact generated contracts, and CRM unit behavior.
- `mise exec -- pnpm --filter @app/crm test:component` — validate `CustomerForm` reuse and CustomerCreate mutation, idempotency, accessibility, localization, and navigation behavior.
- `mise exec -- pnpm --filter @app/crm test:integration` — prove the generated client reaches `CreateCustomerAction` through the real strict BFF with governed idempotency, persistence, evidence, typed failures, and isolation.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate CustomerCreate page, form props, typed client errors, target/route-param props, and federation declarations.
- `mise exec -- pnpm i18n:boundaries` — validate CRM-owned Czech/English copy and namespace boundaries.
- `mise exec -- pnpm api:check` — enforce strict Effect BFF topology and prevent forbidden frontend/backend API paths.
- `mise exec -- pnpm module-entrypoints:check` — validate exact generated page gating, private lazy registration, and absence of raw remote loads.
- `mise exec -- pnpm check:module-contracts` — validate the CRM dynamic page contribution, manifest/registration identity, and non-navigation rule.
- `mise exec -- pnpm --filter @app/crm build` — compile the independently deployable CRM page, UI-kit/query integration, BFF client, and Module Federation exposure.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Shell exact-target resolution, bounded route params, and approved remote props.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Stable generator identity is lower-kebab `customer-create`, producing `CustomerCreatePage`; the locale is router-owned, so Codesmith receives `/crm/customers/:id/new`, not `/cs/crm/customers/:id/new`.
- The user-specified `id` segment has no business meaning in the implemented `CreateCustomerPayloadSchema`. This plan deliberately preserves the exact requested URL while keeping creation input `{ name }`. If `id` is later assigned a parent-resource meaning, that requires a separately approved Action/API contract change rather than implicit frontend behavior.
- `CustomerForm` was explicitly approved and implemented as an owner-private ordinary React presentation component in the CustomerEdit feature. This feature reuses it and does not need a public-component generator or new component-creation decision.
- Customer currently has one create-time business field, `name`; adding fields is outside this feature.
- TanStack Query is reused because the federated page executes its mutation at the framework edge and CRM already owns the dependency/provider pattern. No initial query or loading fetch is needed for an empty create form.
- The generated Customers list is the concrete localized Back/Cancel/success destination. A Customer-detail page remains planned but is not currently implemented, so this feature does not navigate to an invented detail route.
- No unresolved decision blocks implementation under the current Customer contract and the exact route supplied by the developer.

## Implementation Evidence

### Summary

- Generated and implemented the private localized CRM CustomerCreate page, its owner/Shell route wiring, manifest/registration/federation entries, approved lazy client, and compatibility metadata.
- Reused the owner-private `CustomerForm` for normalized create submission through the generated `createCustomer` Effect BFF client, including exact typed-error mapping, logical idempotency, writable gating, localized feedback, and list navigation.
- Added focused CRM component and Shell unit coverage, then validated the existing real CRM Action/BFF integration path without changing its contract.

### Changed Files

18 files changed, 1,333 insertions, 0 deletions: generated route/contract wiring, one owner page, one federation wrapper, Czech/English copy, one CRM component-test file, two Shell unit-test updates, and this completed plan.

### Tests Written or Updated

- `verticals/crm/tests/components/customer-create-page.test.tsx` — proves empty localized form composition, validation/focus/keyboard submission, exact generated-client payload and options, pending and writable gates, logical idempotency, exhaustive typed-error classification, navigation, locale parity, and forbidden-boundary absence.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — proves exact CustomerCreate target resolution, attacker-field rejection, bounded `id` selection, and overlong-ID removal.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — proves the approved remote receives bounded route context and the resolved writable target only after lazy target resolution.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 20 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 62 tests across 4 files.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 3 tests against an isolated disposable PostgreSQL/SpiceDB test environment.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm --filter @app/crm build` — passed with a deterministic source snapshot revision because the repository correctly rejects promotable build metadata for an uncommitted worktree.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 154 tests across 22 files.
- `mise exec -- pnpm check` — passed, including formatting, lint, typecheck, architecture, contract, workspace, and performance gates.

### Review

- Reviewed the complete diff against `../AGENTS.md`, `AGENTS.md`, the full specification, and the referenced MicroVertical, Action, Effect error, module-entrypoint, module-manifest, UltraModern, frontend, and Figma guidance.
- Fixed the review findings by sorting the generated Module Federation exposures and strengthening the Shell overlong-route assertion plus the complete typed-client-error table; affected tests and the final quality gate passed afterward.
- Browser-validated the built `/en/crm/customers/context/new` page at desktop and 390 px mobile widths: correct Back/heading/surface arrangement, accessible read-only status, no enabled mutation path, responsive actions, HTTP 200, and no console warnings or errors. Evidence: `.codex/reports/review/feature-crm-customer-create-page/customer-create-read-only-desktop.png`.

### Deviations and Follow-ups

- None. The temporary isolated database and production review server were removed/stopped after validation.
