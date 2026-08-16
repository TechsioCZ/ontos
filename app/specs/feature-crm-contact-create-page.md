---
type: feature
status: done
created: 2026-08-16
---

# Feature: CRM Contact create page

## Feature Description

Add the generated CRM `ContactCreate` page at localized URL
`/cs/crm/customers/:id/contacts/new` (canonical generator URL
`/crm/customers/:id/contacts/new`, also exposed under `/en`). The authenticated Shell continues to
own dashboard composition, legal-entity selection, exact page resolution, module-state gating, and
the lazy CRM remote load. The CRM-owned page treats `:id` as the untrusted parent Customer UUID,
validates it at the owner boundary, renders an empty Contact form, and submits `{ customerId, name,
email, phone }` through the existing generated `createContact` Effect client. The CRM BFF endpoint
must execute the existing `CreateContactAction`; the page must not import or call the Action,
persistence service, backend handler, or HTTP endpoint directly.

Use Figma file `ERP`, page `Pre-Alpha Repo` (not `Pre-Alpha`), frame
`Resource Detail — Běžný` (`6:780`, 1440×900) only as an arrangement wireframe. Preserve the
Shell-owned left navigation, compact Back link, page heading, and single main content surface, but
replace the read-only detail rows with inputs. Do not copy Figma styling or add the example's inert
Overview/Documents/Timeline/Audit tabs. Use the installed `@techsio/ui-kit` components and tokens,
with CRM-prefixed Tailwind utilities only for responsive layout composition.

Create a separate owner-private `ContactForm` presentation component for the editable `name`,
`email`, and `phone` values so a later Contact-edit page can reuse the same field, validation,
pending, field-error, form-status, cancel, and submit contract. It receives plain values/states and
semantic callbacks; it does not read route params, navigate, call the BFF, run Effects, access
permissions, or depend on Contact DTO/client-error types.

## User Story

As an authenticated CRM user with write access
I want to add a Contact to a specific Customer from a dedicated localized page
So that the Contact is created through the governed CRM Action boundary and remains associated with
the intended Customer

## Problem Statement

CRM already owns Contact persistence, `CreateContactAction`, the strict Effect BFF mutation, and the
generated `createContact` client, but it has no governed page for entering a Contact. Direct endpoint
use would bypass the intended frontend seam and provide no localized, accessible validation,
pending, denial, conflict, retry, or success experience. The dynamic nested route also requires
Codesmith-owned manifest, registration, federation, Shell connector, route-parameter, and locale
wiring before the business UI can be adapted safely. Without a presentation boundary, the later
Contact-edit page would duplicate the same three fields and their interaction behavior.

## Solution Statement

Run the mandatory MicroVertical page generator with stable identity `contact-create` and canonical
URL `/crm/customers/:id/contacts/new`. Preserve its private/non-indexable exact-page descriptor,
dynamic non-navigation behavior, owner-private registration, Module Federation exposure, approved
Shell lazy client, and bounded `id` propagation. Adapt the generated CRM page and federation wrapper
to receive the resolved target so write availability remains explicit. Decode the owner-side
`routeParams.id` with `CrmUuidSchema`; an absent, malformed, or overlong value renders a localized
not-found state and never invokes the mutation.

Create the explicitly requested owner-private `ContactForm` directly after the page scaffold. Use
`FormInput` for name and email, the compound `PhoneInput` for telephone entry, `Button` for
submit/cancel, and `StatusText` for field/form feedback. Keep validation aligned with the existing
Action input schemas: trimmed non-empty name (maximum 200), trimmed email matching the current
3–320-character CRM email contract, and trimmed non-empty phone (maximum 100). Do not enable
`PhoneInput`'s stricter libphonenumber native validation because `CrmPhoneSchema` does not currently
require a valid E.164 number.

Use the established page-local TanStack Query mutation pattern to bridge `createContact` at the
framework edge, retain its operation-specific typed error union, and map every expected failure into
field or form UI state. Generate one idempotency key per logical `{ customerId, name, email, phone }`
intent, reuse it only after an uncertain failure when all normalized values are unchanged, and
generate a fresh correlation ID for every attempt. On success, navigate to the localized existing
Customer-detail route `/${language}/crm/customers/${customerId}`; Back and Cancel use the same
destination without invoking the Action.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — `app/`-only scope and mandatory MicroVertical page generator rule.
- `AGENTS.md` — authoritative MicroVertical, Action, BFF, module-entrypoint, frontend, Figma, and toolchain constraints.
- `README.md` — dynamic page URL grammar, locale ownership, strict Effect BFF topology, and repository validation commands.
- `docs/architecture/MICROVERTICALS.md` — generated CRM BFF client seam and prohibition on frontend backend imports or ad hoc fetches.
- `docs/architecture/ACTIONS.md` — required Action lifecycle, parent lookup, idempotency, trusted context, and typed failure behavior.
- `docs/architecture/ERRORS.md` — operation-specific typed client errors and exhaustive UI mapping.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact dynamic-page resolution, bounded route params, write availability, and lazy private load ordering.
- `docs/architecture/MODULE_MANIFESTS.md` — generator-owned page identity, manifest/registration slots, and dynamic non-navigation rules.
- `docs/architecture/ULTRAMODERN.md` — Codesmith-first business artifacts and Effect-first feature integration.
- `docs/frontend/FRONTEND.md` — route/presentation separation, component approval, UI-kit reuse, i18n, explicit states, accessibility, and responsive behavior.
- `docs/frontend/FIGMA.md` — Figma is arrangement-only and must not replace UI-kit visuals.
- `../docs/11_V0_SCOPE_AND_MODULES.md` — product context for Contact reuse across later rental modules.
- `../docs/12_ROADMAP.md` — August CRM/contact basics delivery context.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory generator that creates the initial owner/Shell page files and patches governed wiring atomically.
- `specs/feature-crm-customer-contact-actions.md` — implemented owner of `CreateContactAction`, its payload/result, strict BFF mapping, generated client, authentication, idempotency, and integration coverage.
- `specs/feature-crm-customer-edit-page.md` — implemented precedent for a generated nested CRM form page, target writability, mutation idempotency, typed UI states, and localized navigation.
- `specs/feature-crm-customer-detail-page.md` — implemented parent Customer route used as the Back/Cancel/success destination.
- `verticals/crm/package.json` — existing UI-kit, TanStack Query, Rstest, integration-test, typecheck, and build setup to reuse without dependency changes.
- `verticals/crm/shared/apis/contact-detail.ts` — authoritative Contact values, `CreateContactPayloadSchema`, field limits, and expected not-found error.
- `verticals/crm/shared/api.ts` — strict `createContact` BFF endpoint, idempotency header, result, and declared public Problem Details union.
- `verticals/crm/src/api/crm-client.ts` — generated `createContact` Effect client method that the page must call exclusively.
- `verticals/crm/src/actions/create-contact.action.ts` — existing generated Action descriptor and handler registration reached through the BFF, never imported by the page.
- `verticals/crm/api/index.ts` — existing strict BFF handler mapping `createContact` to `createContactAction`.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — closest owner-side query/mutation, idempotency, target-writability, error-mapping, and navigation precedent.
- `verticals/crm/src/features/customers/customer-form.tsx` — presentation-only form contract and accessible interaction precedent; do not overload it with Contact fields.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx` — implemented Customer-detail destination and route-ID decoding precedent.
- `verticals/crm/tests/components/customer-form.test.tsx` — reusable form testing and dependency-boundary precedent.
- `verticals/crm/tests/components/customer-edit-page.test.tsx` — typed mutation, idempotency, write-gating, localization, and navigation test precedent.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — real generated-client-to-BFF proof for Contact creation and typed public failures.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — real Action runtime, parent lookup, persistence, idempotency, evidence, rollback, and tenant-isolation proof.
- `verticals/crm/locales/cs/crm.json` — Czech page, form, mutation, state, and accessibility copy.
- `verticals/crm/locales/en/crm.json` — English counterpart with an identical key structure.
- `verticals/crm/vertical.manifest.ts` — generated private page component and exact page contribution slots.
- `verticals/crm/vertical.registration.ts` — generated owner-private lazy page registration.
- `verticals/crm/module-federation.config.ts` — generated `PageContactCreate` exposure.
- `verticals/crm/src/routes/ultramodern-route-metadata.ts` — generated CRM compatibility metadata to verify after adding the route.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated approved `PageContactCreate` lazy-client entry.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic exact-target loader and bounded declared-route-param selection.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell wrapper that passes route params and the resolved target after approval.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — Shell exact-target and route-parameter propagation coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — authorization-before-remote-load and resolved target/route-param prop coverage.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — authenticated/anonymous multi-deployment browser coverage and responsive Customer-route precedent.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/new/page.tsx` — generated `ContactCreatePage`, then adapted for form composition, route-ID validation, target writability, typed BFF mutation orchestration, and localized navigation.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/new/route.meta.ts` — generated private/non-indexable dynamic owner route metadata.
- `verticals/crm/src/federation/page-contact-create.tsx` — generated localized Module Federation wrapper, adapted to pass the resolved target and route params.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/new/page.tsx` — generated authenticated Shell connector.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/new/page.data.ts` — generated exact-target loader carrying only the declared bounded `id` parameter.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/new/route.meta.ts` — generated private Shell route metadata.
- `verticals/crm/src/features/contacts/contact-form.tsx` — explicitly approved owner-private reusable Contact create/edit presentation form.
- `verticals/crm/tests/components/contact-form.test.tsx` — reusable field, validation, keyboard, focus, pending, error, and dependency-boundary tests.
- `verticals/crm/tests/components/contact-create-page.test.tsx` — route-ID, write-gating, BFF payload, typed errors, idempotency, localization, accessibility, and navigation tests.

## Implementation Plan

### Phase 1: Foundation

Generate the exact nested page and all owner/Shell wiring before adapting business code. Verify the
generator retains the canonical route without a locale prefix, carries only `id`, omits dynamic
navigation, and creates stable `contact-create` identities. Then create the explicitly approved
owner-private `ContactForm`, reusing the repository-pinned UI-kit and current CRM test/query setup;
add no backend contract, Action, persistence, dependency, shared component, or token override.

### Phase 2: Core Implementation

Implement `ContactForm` as a reusable presentation contract using the installed UI-kit field and
feedback components. Adapt the generated ContactCreate page and federation wrapper to validate the
parent ID, honor `target.writable`, render an empty ready form, and submit through the generated
`createContact` Effect client with correct typed error and logical-idempotency behavior. Add focused
tests beside each reusable form and page behavior.

### Phase 3: Integration

Complete Czech/English copy, generated manifest/registration/federation/Shell verification,
responsive and keyboard behavior, localized parent navigation, and browser coverage. Reuse the real
CRM BFF/Action integration suites as the authoritative proof that the page's client method reaches
`CreateContactAction` through the strict BFF and governed Action runtime. Finish with independent
CRM/Shell checks, boundary validators, builds, and the final repository quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the ContactCreate page and governed wiring

- [x] From `app/`, make the first implementation change by running `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page contact-create --url /crm/customers/:id/contacts/new`; do not create the initial route, metadata, federation, manifest, registration, locale, approved-client, or Shell connector files by hand.
- [x] Inspect the complete generated mutation set. Retain `ContactCreatePage`, `page-contact-create`, `crm.core.page.contact-create`, canonical `/crm/customers/:id/contacts/new`, `[lang]/crm/customers/[id]/contacts/new` filesystem routing, private/non-indexable metadata, tenant `page`/`read` ownership, exact Shell connector, and no ordinary navigation contribution.
- [x] Verify generated owner and Shell compatibility route metadata, manifest component/page slots, owner-private registration, `./PageContactCreate` exposure, and approved Shell lazy-client identity agree exactly; update contract assertions only where the new generated identity needs explicit coverage.

### 2. Preserve resolved target and parent-ID boundaries

- [x] Adapt the generated owner page props and `page-contact-create.tsx` federation wrapper using the established CustomerEdit pattern so the Shell-supplied `target.writable` and declared `routeParams.id` reach the owner page only after exact target resolution.
- [x] Bound and decode `routeParams.id` with the existing `CrmUuidSchema` before rendering an enabled form. Treat it only as untrusted business input for `CreateContactPayload.customerId`; never use it as tenant, legal-entity, principal, module-state, permission, or gateway context.
- [x] Render an explicit localized not-found/invalid-target state and perform no `createContact` call when `id` is absent, overlong, malformed, or undecodable. Let `CreateContactAction` authoritatively return typed not-found when a well-formed Customer UUID is absent or tenant-invisible at execution time.
- [x] Extend Shell unit assertions as needed to prove the generated connector selects only `id`, bounds it through `selectRouteParams`, resolves `crm.core.page.contact-create` before lazy loading, and passes both route params and the resolved target to the approved remote.

### 3. Create and test the reusable owner-private ContactForm

- [x] Create `verticals/crm/src/features/contacts/contact-form.tsx` directly only after the page generator. The user's request explicitly approves this owner-private ordinary React presentation component for Contact create/edit reuse; do not use `scaffold:public-component`, publish it through the manifest/federation boundary, or turn it into a shared cross-domain abstraction.
- [x] Define a plain contract with `initialValues: { name: string; email: string; phone: string }`, localized field/action/validation copy, optional per-field errors and form status, disabled/pending state, `onSubmit(values)`, `onCancel()`, and `onValuesChange(values)`. Keep Customer ID, route, query, BFF, Effect, permission, navigation, Contact DTO, and client-error types outside the component.
- [x] Compose installed `@techsio/ui-kit@0.25.1` `FormInput` controls for required name and email, and compound `PhoneInput` parts (`Label`, `Control`, `CountryPicker`, `Input`, `StatusText`) for required phone entry. Use `Button` for primary submit and secondary outlined Cancel, and `StatusText` for form status. Use component props/tokens for appearance and CRM-prefixed Tailwind only around components for responsive layout; do not add native/custom primitives, plain CSS, component appearance classes, token overrides, or Figma-derived values.
- [x] Normalize trimmed submitted values and enforce the existing Action schema constraints locally: name required/max 200, email required/3–320/existing CRM email pattern, and phone required/max 100. Keep `PhoneInput`'s default Czech country/formatting behavior but leave `nativeValidation` disabled so the presentation does not reject non-E.164 values currently accepted by `CrmPhoneSchema`.
- [x] Associate every error with its field through stable IDs and ARIA relationships, focus the first invalid field in name/email/phone order, support Enter submission, prevent duplicate semantic submits while a callback is unsettled, expose localized loading text, disable all controls while pending/read-only, clear stale feedback on value changes, and keep Cancel mutation-free.
- [x] Add `contact-form.test.tsx` proving empty create values and non-empty future-edit values, value change emission, trimming, every field constraint, email format, phone compound behavior, first-invalid focus, keyboard submission, duplicate-submit suppression/release, pending/loading/disabled controls, Cancel, supplied field/form errors, live status, accessible names/descriptions, responsive action semantics, and absence of route/BFF/Effect/domain dependencies.

### 4. Render Contact-create states from typed page integration

- [x] In the generated page, create one stable page-local `QueryClientProvider`, following the existing CustomerEdit pattern, and use `useMutation` for the create operation. Do not add an initial Customer query: an empty form is the intentional ready state, and the Action performs the authoritative parent existence check.
- [x] Follow the `Pre-Alpha Repo` / `Resource Detail — Běžný` arrangement with a localized Back-to-Customer link, Contact-create heading/description, and `ContactForm` replacing the detail rows. Keep Shell chrome outside CRM, omit inert tabs, use UI-kit defaults/tokens, and support narrow mobile through desktop widths.
- [x] When `target.writable` is false, show a localized read-only/forbidden explanation and expose no enabled mutation path; a Shell target denial/unavailable state remains Shell-owned and must prevent the remote from loading. Submission pending is the page's loading state; there is no separate empty-data state.
- [x] Make Back and Cancel navigate to `/${language}/crm/customers/${customerId}` without mutation. Keep all visible and accessibility copy in the CRM locale catalogs.
- [x] Add page tests for valid/invalid route IDs, empty initial values, Figma-derived arrangement only, Back/Cancel destinations, `target.writable` gating, pending state, absence of a Customer-detail query, no enabled form for invalid input, and no direct backend/Action/persistence imports.

### 5. Submit CreateContactAction through the generated CRM BFF client

- [x] Execute only `createContact({ customerId, name, email, phone }, { baseUrl, correlationId, idempotencyKey, locale })` through `runEffectRequest` inside the page mutation. Do not use `fetch`, construct the endpoint path, import `api/index.ts`, import `createContactAction`, or access the persistence service.
- [x] Keep the exact `Effect.Error<ReturnType<typeof createContact>>` union at the mutation boundary and map it exhaustively: structural `CrmInvalidRequestProblem` to localized invalid-form feedback; authentication expiry and definite forbidden denial to error status; `CrmNotFoundProblem` to a terminal parent-Customer-not-found message; conflict/precondition to warning; declared `503`, gateway unavailability/rate limiting, transport failure, and response/schema decode failure to retryable uncertain state; and sanitized internal/audience failures to a generic non-sensitive error.
- [x] Generate one idempotency key for each new normalized `{ customerId, name, email, phone }` intent. Reuse it only after an uncertain failure when the Customer ID and all values remain unchanged; generate a new key after any value change, a different Customer ID, success, or definite terminal failure. Generate a fresh correlation ID for every network attempt, including a same-intent retry.
- [x] On success, clear the logical attempt, make success available to the form's polite status contract, and navigate through the localized router to the existing Customer-detail page. Do not invent a Contact-detail destination or optimistically alter unrelated caches.
- [x] Add page tests proving exact normalized payload/options, route ID inclusion only as `customerId`, one semantic mutation per submit, same-key uncertain retry, changed-intent/customer key renewal, fresh correlations, full typed error classification, retained values and no navigation on failure, and localized parent navigation on success.

### 6. Complete i18n, generated boundaries, and browser coverage

- [x] Replace generator starter copy under `crm.pages.contactCreate` in both CRM catalogs with matching structures for title, description, Back, form labels/actions, required/invalid messages, pending, read-only/forbidden, authentication, parent-not-found, conflict, unavailable/retry guidance, generic failure, and success. Include a localized phone placeholder/native text only if the chosen UI-kit prop exposes it; do not rely on the UI kit's English default placeholder or validation message for visible copy.
- [x] Keep owner and Shell route metadata private and non-indexable. Verify Czech runtime URL `/cs/crm/customers/:id/contacts/new`, English runtime URL `/en/crm/customers/:id/contacts/new`, and canonical generator route `/crm/customers/:id/contacts/new` without adding a locale to the manifest template.
- [x] Add locale-parity and architecture assertions proving `ContactForm` remains owner-private, the page imports only the frontend CRM client seam, no direct `fetch`/backend/Action/persistence import exists, the dynamic page is absent from navigation, and owner/Shell/federation identities remain exact.
- [x] Reuse and run the existing CRM BFF/Action integration tests as the authoritative cross-boundary proof; extend them only if the page exposes a missing assertion for Contact parent lookup, payload normalization, typed not-found, or idempotency. Do not replace their real `CreateContactAction` proof with a page mock.
- [x] Add a focused Shell Playwright flow for anonymous privacy, authenticated English/Czech form rendering, keyboard/accessibility behavior, 375 px no-overflow layout, and a mocked successful/failed Contact BFF response that verifies the real page issues the correct `/crm/contacts/create` request and navigates to the parent Customer. Keep database mutation proof in the existing CRM integration suite so browser fixture cleanup does not acquire Action-runtime ownership.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve feature-related failures without changing the existing Contact Action/API contract, adding Contact fields, creating a second Contact form, introducing UI-kit/token changes, weakening exact page gating, or modifying unrelated CRM behavior.

## Testing Strategy

### Unit Tests

Use the existing CRM Node unit tests for Action/API schemas and add Rstest/Testing Library coverage
for `ContactForm` and the generated ContactCreate page. Mock only the generated frontend Effect
client seam in page tests. Prove reusable presentation ownership, Action-aligned field validation,
keyboard/focus/accessibility behavior, valid/invalid parent IDs, write gating, exact
`createContact` payload/options, typed failure mapping, logical idempotency, localized parent
navigation, and absence of forbidden frontend dependencies. Use Shell Rstest coverage for exact page
resolution, bounded `id` propagation, and lazy remote props.

### Integration Tests

Run the existing CRM integration suites that execute Contact creation through the contract-derived
client/BFF and the real Action runtime. They prove assertion verification, `CreateContactAction`
dispatch, Customer parent lookup, idempotency, tenant/module/write scope, persistence, data-access and
audit evidence, typed Problem Details decoding, rollback, and tenant isolation. Add focused Shell
browser coverage for privacy, form behavior, real page-to-BFF request construction, localized
navigation, and responsive layout while mocking the terminal BFF response to avoid introducing new
Action cleanup responsibilities into the browser fixture.

### Edge Cases

- The route `id` is missing, overlong, malformed, a well-formed absent Customer UUID, or belongs to another tenant.
- CRM is active and writable, read-only/deprecated, definitely denied, or its exact target resolution is unavailable.
- Name is empty, whitespace-only, padded, or over 200 characters.
- Email is empty, padded, malformed, mixed-case, or at the 3/320-character boundaries; server-side lowercase normalization remains authoritative.
- Phone is empty, padded, over 100 characters, formatted for a supported country, or non-E.164 but still valid under the current CRM contract.
- Submit is triggered by keyboard, double click, or repeated activation while pending.
- Authentication expires, permission is denied, the parent Customer disappears, idempotency conflicts, the BFF is unavailable, transport fails, or the response cannot be decoded.
- An uncertain same-intent retry reuses its key; any changed field or Customer ID starts a new logical attempt and every attempt has a fresh correlation ID.
- Success, Back, and Cancel preserve the active locale and parent Customer; Back/Cancel never invoke the Action.
- Long translated labels and values remain keyboard/assistive-technology usable without horizontal overflow at 375 px.

## Acceptance Criteria

- [x] Codesmith creates page identity `contact-create` at canonical `/crm/customers/:id/contacts/new`; authenticated Czech and English URLs are `/cs/crm/customers/:id/contacts/new` and `/en/crm/customers/:id/contacts/new`.
- [x] The page is registered in CRM manifest/registration/federation and the approved Shell client, remains private/non-indexable, is absent from ordinary navigation, and loads only after authenticated exact-page gating.
- [x] The owner validates the bounded route `id` as a Customer UUID and sends it only as `CreateContactPayload.customerId`, never as trusted operational context.
- [x] The `Pre-Alpha Repo` / `Resource Detail — Běžný` arrangement is recognizable through the Back link, heading, and main form surface without copied Figma styling or inert tabs.
- [x] One new owner-private `ContactForm` supports both empty create and populated future-edit values for name, email, and phone without routing, BFF, Effect, permission, or domain dependencies.
- [x] The form uses installed UI-kit `FormInput`, compound `PhoneInput`, `Button`, and `StatusText` components with default tokens and no new shared primitive, CSS, or token override.
- [x] Name, email, and phone normalization/validation match the current `CreateContactPayloadSchema`; invalid fields are associated, announced, and focused in deterministic order.
- [x] A valid submit calls the generated `createContact` Effect client, whose existing BFF handler invokes `CreateContactAction`; no direct fetch, endpoint construction, backend import, Action import, or persistence access exists in the page.
- [x] Logical submissions use correct idempotency semantics: same-key retry only after uncertain unchanged intent, a new key after changed intent or definite outcome, and a fresh correlation ID per attempt.
- [x] Invalid parent/fields, pending, read-only, authentication, forbidden, parent-not-found, conflict, unavailable/retryable, decode, generic failure, and success behavior are explicit, localized, accessible, and covered by tests.
- [x] A non-writable resolved target exposes no enabled mutation path; Shell denial/unavailability never loads CRM private code.
- [x] Successful creation navigates to the localized parent Customer detail; Back and Cancel use the same destination without mutation.
- [x] Czech and English catalogs have matching `contactCreate` keys and no user-facing string is hardcoded in application TSX.
- [x] Focused form/page/Shell browser tests and the real CRM BFF/Action integration suites prove both frontend behavior and governed Contact creation without weakening deployment seams.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate existing Contact Action/API schemas, generated contracts, and CRM unit behavior.
- `mise exec -- pnpm --filter @app/crm test:component` — validate `ContactForm` and ContactCreate mutation, idempotency, accessibility, localization, and navigation behavior.
- `mise exec -- pnpm --filter @app/crm test:integration` — prove the generated client reaches `CreateContactAction` through the real strict BFF with governed parent lookup, idempotency, persistence, evidence, typed failures, and isolation.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate ContactCreate page, form props, PhoneInput usage, typed client errors, target/route-param props, and federation declarations.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Shell exact-target resolution, bounded route params, approved remote props, and authorization-before-load ordering.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — verify authenticated exact-page resolution remains typed and fail-closed.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e -- --grep "Contact create|CRM"` — run anonymous/authenticated localized Contact-create, BFF request, navigation, keyboard, and responsive browser coverage.
- `mise exec -- pnpm i18n:boundaries` — validate CRM-owned Czech/English copy and namespace boundaries.
- `mise exec -- pnpm api:check` — enforce strict Effect BFF topology and prevent forbidden frontend/backend API paths.
- `mise exec -- pnpm module-entrypoints:check` — validate exact generated page gating, private lazy registration, and absence of raw remote loads.
- `mise exec -- pnpm check:module-contracts` — validate the CRM dynamic page contribution, manifest/registration identity, and non-navigation rule.
- `mise exec -- pnpm --filter @app/crm build` — compile the independently deployable CRM page, UI-kit/query integration, BFF client, and Module Federation exposure.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Validation Evidence

- Passed CRM unit (20), component (98), and integration (3) tests; Shell unit tests (156); the two focused Contact-create Playwright flows; database schema verification; the full repository `pnpm check`; CRM production build; Module Federation type assertion; performance readiness; and the full workspace production build.
- The specification and documented-standards reviews both completed with no remaining actionable findings after their requested fixes were applied.
- `@app/crm typecheck` remains red only on the unchanged CustomerDetail route-component mismatch and CustomerDetail test Effect diagnostics that reproduce on the base worktree. The final root workspace typecheck and CRM build/type generation pass, including the new ContactCreate source and federation declaration.
- The full Shell integration suite retains three unrelated baseline failures: two stale auth-runtime expectations and the generated-owner gateway-issuer fixture. ContactCreate's exact target resolution, bounded route-param propagation, authorization-before-load behavior, and approved remote props pass in the Shell unit suite.
- The listed Playwright command's extra `--` is parsed by the installed Playwright CLI as a test-file filter. The equivalent supported invocation, `mise exec -- pnpm --filter @app/shell-super-app test:e2e --grep "Contact create"`, passed both focused flows.

## Notes

- Stable generator identity is lower-kebab `contact-create`, producing `ContactCreatePage`; the locale is router-owned, so Codesmith receives `/crm/customers/:id/contacts/new`, not the `/cs` URL.
- The route `id` has concrete business meaning here: it is the parent `customerId` required by the existing `CreateContactPayloadSchema`, but it remains untrusted until decoded by the CRM owner page and independently checked by `CreateContactAction`.
- The user's request explicitly approves creation of one owner-private reusable Contact form for later edit reuse. That resolves the frontend component-creation decision and the no-generator business-file decision for `contact-form.tsx`; it does not authorize a public/shared UI-kit component or cross-domain abstraction.
- UI-kit workflow guidance currently describes library version `0.3.2`, while this repository pins `@techsio/ui-kit@0.25.1`. The installed `0.25.1` package declarations and runtime were inspected and are authoritative: they expose the required FormInput, PhoneInput compound API, Button, Link, and StatusText props.
- `PhoneInput` defaults to Czech country formatting. Native libphonenumber validity is deliberately not enabled because the existing backend phone contract is trimmed non-empty text up to 100 characters; strengthening that domain rule requires a separate Action/API decision.
- Figma source was inspected locally in the view-only `ERP` file on `Pre-Alpha Repo`; `Resource Detail — Běžný` was selected. Only its Back/heading/content arrangement is used, consistent with `docs/frontend/FIGMA.md`.
- The implemented Customer-detail page is the concrete localized Back/Cancel/success destination. No Contact-detail or Contact-list page is invented by this feature.
- The initial empty form is a successful ready state, not an empty-data error. No Customer read is needed before submit because the existing Action performs the authoritative tenant-scoped parent lookup.
- No unresolved decision blocks implementation.
