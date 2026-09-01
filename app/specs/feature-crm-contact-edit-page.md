---
type: feature
status: done
created: 2026-08-16
---

# Feature: CRM Contact edit page

## Feature Description

Add the generated CRM `ContactEdit` page at localized URL
`/cs/crm/customers/:id/contacts/:contactId/edit` (canonical generator URL
`/crm/customers/:id/contacts/:contactId/edit`, also exposed under `/en`). The authenticated Shell
continues to own legal-entity selection, exact page resolution, module-state and page-permission
gating, dashboard composition, and the approved lazy CRM remote load. The CRM page treats both route
parameters as untrusted business input, loads the addressed Contact through the existing
contract-derived `getContact` Effect BFF client, verifies that the Contact belongs to the Customer
named by the hierarchical URL, and pre-populates the existing owner-private `ContactForm`.

Valid edits submit `{ contactId, name, email, phone }` through the existing generated `editContact`
Effect client. Its strict CRM BFF handler must dispatch the already generated `EditContactAction`
through the governed Action runtime; the page must not import or call the Action, BFF server,
persistence service, database, or HTTP endpoint directly.

Use Figma file `ERP`, page `Pre-Alpha Repo` (not `Pre-Alpha`), frame
`Resource Detail — Běžný` (`6:780`, 1440×900) only as an arrangement wireframe. Preserve the
Shell-owned left navigation, compact Back link, page heading, and one main content surface, while
replacing the read-only detail rows with the existing Contact inputs. Do not copy Figma styling or
add the example's inert Overview/Documents/Timeline/Audit tabs. Use installed
`@techsio/ui-kit` components and tokens, with CRM-prefixed Tailwind utilities only for responsive
layout composition.

## User Story

As an authenticated CRM user with write access
I want to edit an existing Contact within its Customer context
So that corrected communication details are persisted through the governed CRM Action boundary

## Problem Statement

CRM already owns Contact persistence, `EditContactAction`, the strict Effect BFF mutation,
`getContact`, `editContact`, a localized Contact-detail page, and a reusable Contact create/edit
form. It has no governed Contact-edit route that combines those capabilities. Users therefore
cannot load current Contact values, correct them, receive accessible validation and typed failure
feedback, or return safely to the Contact detail without bypassing the generated page/BFF seams.

The nested dynamic page also requires Codesmith-owned manifest, registration, Module Federation,
Shell connector, route-parameter, metadata, and locale wiring. Hand-authoring that initial wiring
would violate the repository's generator and module-entrypoint rules.

## Solution Statement

Run the mandatory MicroVertical page generator with stable identity `contact-edit` and canonical
URL `/crm/customers/:id/contacts/:contactId/edit`. Preserve its private/non-indexable exact-page
descriptor, dynamic non-navigation behavior, owner-private registration, Module Federation
exposure, approved Shell lazy client, and bounded propagation of only `id` and `contactId`. Adapt
the generated CRM page and federation wrapper to accept the resolved target so write availability
remains explicit.

At the owner boundary, bound and decode both parameters with `CrmUuidSchema`. Load the Contact only
through `getContact({ contactId })`, retain the operation-specific typed Effect error union, and
require `contact.customerId === id` before exposing any values. Render explicit loading,
authentication-expired, forbidden, not-found, unavailable/retry, read-only, and ready states.

In the ready state, reuse `verticals/crm/src/features/contacts/contact-form.tsx` unchanged with the
loaded `name`, `email`, and `phone`. Submit normalized values only through `editContact` using one
idempotency key per logical edit intent and a fresh correlation ID per network attempt. Preserve
uncertain retry semantics for transport, decode, and retryable backend failures. On success, update
the Contact-detail query cache and navigate to the localized existing Contact-detail route;
Back and Cancel use that same destination without mutation.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — `app/`-only scope and mandatory MicroVertical page generator rule.
- `AGENTS.md` — authoritative MicroVertical, Action, BFF, module-entrypoint, frontend, Figma, and toolchain constraints.
- `README.md` — dynamic page URL grammar, locale ownership, strict Effect BFF topology, and repository validation commands.
- `docs/architecture/MICROVERTICALS.md` — generated CRM BFF client seam and prohibition on frontend backend imports or ad hoc fetches.
- `docs/architecture/ACTIONS.md` — governed Action lifecycle, trusted context, required idempotency, evidence, and transaction behavior.
- `docs/architecture/ERRORS.md` — operation-specific typed client failures, declared Problem Details, and exhaustive UI mapping.
- `docs/architecture/DATA_ACCESS.md` — governed Contact read/write scope, owner-local services, evidence, and tenant isolation.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact dynamic-page resolution, bounded route parameters, target writability, and lazy-load ordering.
- `docs/architecture/MODULE_MANIFESTS.md` — generator-owned page identity, manifest/registration slots, locale-free canonical URLs, and dynamic non-navigation rules.
- `docs/architecture/ULTRAMODERN.md` — Codesmith-first business artifacts and Effect-first feature integration.
- `docs/frontend/FRONTEND.md` — route/presentation separation, UI-kit reuse, i18n, typed UI states, accessibility, and responsive behavior.
- `docs/frontend/FIGMA.md` — Figma is arrangement-only; UI-kit components and tokens remain the visual source of truth.
- `../docs/11_V0_SCOPE_AND_MODULES.md` — product context for Contacts reused by later property and rental modules.
- `../docs/12_ROADMAP.md` — August CRM/contact basics delivery context.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory generator that creates the owner/Shell page files and patches governed wiring atomically.
- `specs/feature-crm-customer-contact-actions.md` — implemented owner of `EditContactAction`, `getContact`, `editContact`, strict BFF mapping, typed errors, idempotency, and real integration coverage.
- `specs/feature-crm-contact-create-page.md` — implemented owner of the reusable `ContactForm` and Contact mutation/idempotency/UI-state patterns.
- `specs/feature-crm-contact-detail-page.md` — implemented two-parameter route, parent-consistency check, `getContact` query, localized destination, and responsive state patterns.
- `specs/feature-crm-customer-edit-page.md` — implemented precedent for combining a detail query, reusable form, target writability, typed mutation, cache update, and localized navigation.
- `verticals/crm/package.json` — existing UI-kit, TanStack Query, Rstest, integration-test, typecheck, and build setup to reuse without dependency changes.
- `verticals/crm/shared/apis/contact-detail.ts` — authoritative Contact DTO, UUID and field schemas, edit payload, detail request, and typed read errors.
- `verticals/crm/shared/api.ts` — existing strict `editContact` endpoint, idempotency header, success schema, and addressed mutation Problem Details union.
- `verticals/crm/src/api/crm-client.ts` — generated `getContact` and `editContact` Effect client methods that the page must call exclusively.
- `verticals/crm/src/actions/edit-contact.action.ts` — existing generated `EditContactAction` reached through the BFF; never import it into frontend code.
- `verticals/crm/api/index.ts` — existing strict BFF handler that maps `editContact` to `editContactAction`; no new endpoint is required.
- `verticals/crm/src/features/contacts/contact-form.tsx` — existing owner-private presentation form to reuse unchanged for loaded name/email/phone values, validation, feedback, pending state, Cancel, and submit.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/new/page.tsx` — existing Contact-form copy, typed mutation classification, logical idempotency, correlation, and write-gating pattern.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.tsx` — existing hierarchical ID decoding, `getContact` query, parent check, query-key shape, error mapping, and Contact-detail destination.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — closest combined detail-query/edit-mutation/cache/navigation precedent.
- `verticals/crm/tests/components/contact-form.test.tsx` — existing proof of reusable create/edit initial values, Action-aligned validation, accessibility, and dependency boundaries.
- `verticals/crm/tests/components/contact-create-page.test.tsx` — existing Contact mutation, idempotency, target-writability, localization, and navigation test patterns.
- `verticals/crm/tests/components/contact-detail-page.test.tsx` — existing route, parent mismatch, query, retry, localization, and responsive presentation tests.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — real contract-derived client-to-BFF proof for `getContact`, `editContact`, typed failures, and request metadata.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — real Action/Read runtime proof for Contact persistence, immutable parent, idempotency, evidence, rollback, and tenant isolation.
- `verticals/crm/locales/cs/crm.json` — Czech Contact-edit page, form, query, mutation, state, and accessibility copy.
- `verticals/crm/locales/en/crm.json` — English counterpart with the same key structure.
- `verticals/crm/vertical.manifest.ts` — generator-owned private page component and exact page-contribution slots.
- `verticals/crm/vertical.registration.ts` — generator-owned owner-private lazy page registration.
- `verticals/crm/module-federation.config.ts` — generator-owned `PageContactEdit` exposure.
- `verticals/crm/src/routes/ultramodern-route-metadata.ts` — generated CRM compatibility route metadata to verify after generation.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated approved `PageContactEdit` lazy-client entry.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic exact-target loader and bounded declared-route-parameter selection.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell wrapper that passes route params and the resolved target only after approval.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — exact target and ordered two-parameter propagation coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — authorization-before-remote-load and resolved target/route-param prop coverage.
- `verticals/crm/tests/support/e2e-customers.ts` — deterministic Customer/Contact browser fixture and cleanup ordering.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — localized anonymous/authenticated CRM page, BFF request, keyboard, and responsive browser coverage.
- `topology/ownership.json` — confirms CRM and Shell ownership and deployment boundaries.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.tsx` — generated `ContactEditPage`, then adapted for hierarchical loading, existing form composition, typed mutation orchestration, and localized navigation.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/route.meta.ts` — generated private/non-indexable owner route metadata.
- `verticals/crm/src/federation/page-contact-edit.tsx` — generated localized Module Federation wrapper accepting the resolved target and the two declared route parameters.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.tsx` — generated authenticated Shell connector.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.data.ts` — generated exact-target loader carrying only bounded `id` and `contactId`.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/route.meta.ts` — generated private Shell route metadata.
- `verticals/crm/tests/components/contact-edit-page.test.tsx` — hierarchical query, form prefill, write gating, BFF mutation, typed states, idempotency, cache, localization, accessibility, and navigation tests.

## Implementation Plan

### Phase 1: Foundation

Generate `contact-edit` and all owner/Shell wiring before adapting business code. Verify the
generator retains the locale-free two-parameter route, private/non-indexable metadata, ordered
route parameters, dynamic non-navigation behavior, exact CRM identities, owner-private
registration, and approved lazy-client boundary. Reuse the existing CRM query/test dependencies and
`ContactForm`; add no Action, API, persistence service, form component, shared abstraction,
dependency, UI-kit component, or token override.

### Phase 2: Core Implementation

Adapt the generated page and federation wrapper to validate both route IDs, load the current
Contact with `getContact`, reject a parent mismatch, preserve typed query failures, honor
`target.writable`, and render `ContactForm` with loaded values. Submit only through `editContact`
with logical idempotency and exhaustive error mapping, then update the detail cache and navigate to
the localized Contact-detail page.

### Phase 3: Integration

Complete Czech/English copy, generated manifest/registration/federation/Shell verification,
responsive and accessible loading/error/form states, focused component and Shell tests, and
localized browser coverage. Reuse the real CRM BFF/Action integration suites as the authoritative
proof that the page's client method reaches `EditContactAction` through the strict BFF and governed
Action runtime. Finish with the independent CRM/Shell checks, boundary validators, build, and final
repository quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the ContactEdit page and governed wiring

- [x] From `app/`, make the first implementation change by running `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page contact-edit --url /crm/customers/:id/contacts/:contactId/edit`; do not create the initial route, metadata, federation, manifest, registration, locale, approved-client, or Shell connector files by hand.
- [x] Inspect the complete generated mutation set. Retain `ContactEditPage`, `page-contact-edit`, `crm.core.page.contact-edit`, canonical `/crm/customers/:id/contacts/:contactId/edit`, `[lang]/crm/customers/[id]/contacts/[contactId]/edit` filesystem routing, tenant `page`/`read` ownership, private/non-indexable metadata, exact Shell connector, and no ordinary navigation contribution.
- [x] Verify generated owner and Shell compatibility route metadata, manifest component/page slots, owner-private registration, `./PageContactEdit` exposure, and approved Shell lazy-client identity agree exactly; update contract assertions only where the new generated identity needs explicit coverage.

### 2. Preserve resolved target and hierarchical route boundaries

- [x] Adapt the generated owner page props and `page-contact-edit.tsx` federation wrapper using the established CustomerEdit/ContactCreate pattern so the Shell-supplied `target.writable` and only the declared `routeParams.id`/`routeParams.contactId` reach the owner page after exact target resolution.
- [x] Bound both strings to the existing defensive maximum and decode them with `CrmUuidSchema` before starting a query or exposing an enabled form. Treat `id` only as hierarchical Customer context and `contactId` only as Contact business input; neither value may influence tenant, legal entity, principal, module state, permission, Action identity, or gateway authentication.
- [x] Render a localized safe not-found/invalid-target state and make no `getContact` or `editContact` call when either parameter is absent, overlong, malformed, or undecodable.
- [x] Extend the ContactEdit page test and Shell loader/page unit assertions beside this behavior to prove ordered parameter selection `['id', 'contactId']`, defensive bounds, exact target resolution before lazy loading, resolved-target propagation, and zero CRM calls for local or Shell-owned failures.

### 3. Load and parent-check the Contact through the generated BFF client

- [x] Create one stable page-local `QueryClientProvider` and Contact-detail query following the implemented ContactDetail and CustomerEdit patterns. Call only `getContact({ contactId })` through `runEffectRequest`, with CRM base URL, active locale, and a fresh correlation ID; use no `fetch`, backend import, Action import, persistence access, React fetching effect, or untyped Promise wrapper.
- [x] Use a stable hierarchical query key containing both validated IDs and align it with the implemented Contact-detail cache identity so a successful edit can update the data consumed by the detail page without invalidating unrelated Customers or Contacts.
- [x] Require every successful response to satisfy `contact.customerId === customerId` before constructing ready form values. Map a mismatch to the same safe not-found state and expose none of the returned Contact fields.
- [x] Preserve and exhaustively map the full query error union: authentication-expired, definite forbidden, invalid/not-found, retryable backend/transport/decode unavailability, sanitized internal/unexpected failure, loading, and ready. Use at most one bounded automatic retry only for safe retryable read failures and expose a semantic manual Retry action for authentication/unavailable states.
- [x] Add focused ContactEdit component tests beside the behavior for exact `getContact({ contactId })` input/options, hierarchical query identity, loading, every typed failure class, retry classification, parent mismatch suppression, loaded name/email/phone values, active/archived Contacts, and no forbidden imports.

### 4. Reuse ContactForm in the Figma-derived edit arrangement

- [x] Reuse `verticals/crm/src/features/contacts/contact-form.tsx` unchanged. Supply loaded `{ name, email, phone }`, Contact-edit-specific localized copy, optional field/form feedback, pending/disabled state, `onValuesChange`, `onCancel`, and `onSubmit`. Do not create a second form, publish the form, add Customer ID to its props, or give it route/query/BFF/Effect/permission/navigation dependencies.
- [x] Follow the `Pre-Alpha Repo` / `Resource Detail — Běžný` arrangement with a localized Back-to-Contact link, Contact-edit heading/description, and the existing form replacing the detail rows. Keep Shell chrome outside CRM, omit inert tabs, use UI-kit defaults/tokens, and support narrow mobile through desktop widths.
- [x] While the detail query is pending, render stable accessible loading feedback without editable controls. When the resolved target is non-writable, keep loaded values visible in the disabled form, show a localized read-only explanation, and expose no enabled mutation path. Archived Contacts remain editable when the target is writable because the existing Action preserves lifecycle state.
- [x] Make Back and Cancel navigate to `/${language}/crm/customers/${customerId}/contacts/${contactId}` without invoking `editContact`; use only validated IDs and preserve the active locale.
- [x] Extend the ContactEdit page test beside the presentation for ready-value prefill, unchanged `ContactForm` ownership, disabled/read-only controls, no mutation on Back/Cancel, localized destinations, keyboard/accessibility semantics, no inert tablist, and a 375 px no-overflow layout contract.

### 5. Submit EditContactAction through the strict CRM BFF

- [x] On valid form submission, execute only `editContact({ contactId, name, email, phone }, { baseUrl, correlationId, idempotencyKey, locale })` through `runEffectRequest`. Do not include `customerId` in `EditContactPayload`, construct `/crm/contacts/edit`, import `api/index.ts`, import `editContactAction`, or access the persistence service.
- [x] Keep `Effect.Error<ReturnType<typeof editContact>>` at the mutation boundary and map it exhaustively: `CrmInvalidRequestProblem` to localized invalid-form feedback; authentication and definite forbidden failures to error status; `CrmNotFoundProblem` to terminal Contact-not-found feedback; conflict/precondition to warning; declared `503`, gateway unavailability/rate limiting, transport failure, response/empty-body decode failure, and schema failure to an uncertain retryable state; and sanitized internal/audience failures to generic non-sensitive error feedback.
- [x] Generate one idempotency key for each normalized `{ contactId, name, email, phone }` intent. Reuse it only after an uncertain failure while every normalized value and Contact ID remain unchanged; generate a new key after a value/Contact change, success, or definite failure. Generate a fresh correlation ID for every attempt, including a same-intent retry.
- [x] Treat the returned Contact as untrusted decoded success until its `contactId` and immutable `customerId` match the route. A mismatch must not update cache or navigate and must become sanitized generic feedback.
- [x] On valid success, clear the logical attempt, update the exact Contact-detail query cache with the returned Contact, announce localized success through the form's polite status contract, and navigate to the localized Contact-detail page. Do not mutate the Customer Contact-list cache optimistically or invent another destination.
- [x] Add ContactEdit page tests beside the mutation for exact normalized payload/options, one semantic submit per intent, server-side email normalization response, same-key uncertain retry, changed-intent key renewal, fresh correlations, all typed error classifications, retained values/no navigation on failure, defensive result identity, cache update, success announcement, and localized navigation.

### 6. Complete localization, generated boundaries, and browser proof

- [x] Add matching `crm.pages.contactEdit` structures to Czech and English CRM catalogs for title, description, Back, existing form labels/actions/validation, loading, retry/retrying, read-only, authentication, forbidden, not-found, invalid-form, conflict, backend/transport/decode/internal failure, generic failure, and success. Hardcode no visible or accessibility copy in TSX.
- [x] Keep owner and Shell route metadata private and non-indexable. Verify Czech runtime URL `/cs/crm/customers/:id/contacts/:contactId/edit`, English runtime URL `/en/crm/customers/:id/contacts/:contactId/edit`, and canonical generator route `/crm/customers/:id/contacts/:contactId/edit` without adding locale literals to the manifest template.
- [x] Add locale-parity and architecture assertions proving the page imports only the browser-safe CRM client/shared schemas, `ContactForm` remains owner-private, no direct fetch/backend/Action/persistence path exists, the dynamic page is absent from navigation, and owner/Shell/federation identities remain exact.
- [x] Reuse and run the existing CRM integration suites as the authoritative proof that `getContact` and `editContact` cross the contract-derived BFF and that `editContact` dispatches `EditContactAction` with governed idempotency, persistence, evidence, immutable Customer parent, lifecycle preservation, rollback, and tenant isolation. Extend those suites only if the page exposes a genuinely missing boundary assertion.
- [x] Extend the existing Shell Playwright CRM flow for anonymous privacy, authenticated English/Czech Contact-edit rendering, form prefill, exact `/crm/contacts/detail` and `/crm/contacts/edit` request payloads, typed failure feedback, successful Contact-detail navigation, keyboard behavior, and 375 px no-overflow layout. Keep terminal BFF responses mocked at the public seam when needed; do not duplicate Action persistence setup in the browser fixture.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve feature-related failures without changing Contact schemas, adding fields, creating another form, generating another Action/API, introducing UI-kit/token changes, weakening exact page gating, or modifying unrelated CRM behavior.

## Testing Strategy

### Unit Tests

Use existing CRM Node unit tests for Contact Action/API schemas and add Rstest/Testing Library
coverage for the generated ContactEdit page. Mock only the generated frontend Effect client seam.
Prove two-parameter decoding, parent consistency, hierarchical query/cache identity, complete typed
query and mutation classification, loaded form values, target writability, Action-aligned
validation, exact `getContact`/`editContact` payloads and options, logical idempotency, correlation,
cache/navigation outcomes, localization, keyboard/accessibility behavior, and absence of forbidden
frontend dependencies. Run the unchanged `ContactForm` suite as regression protection for its
reusable create/edit contract. Use Shell unit tests for post-gate ordered route parameters and
approved remote props.

### Integration Tests

Run the existing CRM integration suites that execute Contact read/edit through the
contract-derived client/BFF and real governed Read/Action runtimes. They prove audience assertion
verification, `EditContactAction` dispatch, idempotency, immutable Customer ownership, Contact
lifecycle preservation, persistence, audit/data-access evidence, typed Problem Details decoding,
rollback, and tenant isolation. Add focused Shell browser coverage for private route gating, real
page request construction, localized form behavior/navigation, and responsive layout while mocking
only terminal public BFF responses when deterministic browser cleanup would otherwise duplicate
Action-runtime ownership.

### Edge Cases

- Either `id` or `contactId` is missing, empty, malformed, overlong, or not a CRM UUID.
- Both UUIDs are valid but the loaded or edited Contact belongs to a different Customer.
- The Contact is active or archived; editing preserves its current `archivedAt` value and immutable Customer parent.
- A legacy Contact has an empty email or phone; the form displays the value but requires Action-valid data before saving.
- Name is empty, whitespace-only, padded, or over 200 characters.
- Email is empty, padded, malformed, mixed-case, or at the 3/320-character boundaries; server-side lowercase normalization remains authoritative.
- Phone is empty, padded, over 100 characters, formatted for a supported country, or non-E.164 but still valid under the current CRM contract.
- Initial loading encounters authentication expiry, denial, not-found, transport, decode, backend unavailability, or sanitized internal failure.
- Submit is triggered by keyboard, double click, or repeated activation while pending.
- Edit succeeds, becomes forbidden/not-found, conflicts, loses authentication, is unavailable, has an uncertain transport/decode outcome, or returns a mismatched identity.
- An uncertain unchanged-intent retry reuses its key; any changed field or Contact ID starts a new logical attempt, and every attempt has a fresh correlation ID.
- CRM is active and writable, read-only/deprecated, definitely denied, or unavailable before the remote loads.
- Back, Cancel, and success preserve locale and hierarchical Customer/Contact context; Back/Cancel never invoke the Action.
- Long labels and form values remain keyboard/assistive-technology usable without horizontal overflow at 375 px.

## Acceptance Criteria

- [x] Codesmith generates stable page identity `contact-edit` at canonical `/crm/customers/:id/contacts/:contactId/edit`; authenticated Czech and English URLs add only `/cs` and `/en`.
- [x] The page is registered in CRM manifest/registration/federation and the approved Shell client, remains private/non-indexable, is absent from ordinary navigation, and loads only after authenticated exact-page gating.
- [x] The Shell passes only bounded `id` and `contactId` plus the resolved target; the CRM owner decodes both as UUID business input and never treats them as trusted operational context.
- [x] Valid route input loads the Contact only through the generated `getContact` Effect BFF client, and malformed input or parent mismatch exposes no Contact data and performs no edit.
- [x] Query loading, authentication-expired, forbidden, not-found, backend/transport/decode/internal unavailable, retrying, ready, read-only, active, and archived outcomes are explicit, localized, accessible, and exhaustively typed.
- [x] The existing owner-private `ContactForm` is reused unchanged with loaded name/email/phone values and no route, query, BFF, Effect, permission, navigation, Contact DTO, or client-error dependency.
- [x] Figma `Pre-Alpha Repo` / `Resource Detail — Běžný` influences arrangement only: Back link, heading, and main form surface are preserved while detail rows become inputs; styling remains UI-kit-owned and no inert tabs are added.
- [x] Valid submission calls generated `editContact`, whose existing strict BFF handler dispatches `EditContactAction` through the governed CRM Action runtime; no direct fetch, endpoint construction, backend import, Action import, or persistence access exists in the page.
- [x] The edit payload contains only Contact ID and normalized name/email/phone; Customer ownership and archive state remain unchanged.
- [x] Logical submissions use correct idempotency semantics: same-key retry only after uncertain unchanged intent, a new key after changed intent or definite outcome, and a fresh correlation ID per attempt.
- [x] Validation, authentication, forbidden, not-found, conflict/precondition, unavailable/retryable, decode/transport, result-identity, generic failure, and success behavior remain typed until mapped to accessible form/page states.
- [x] A non-writable resolved target shows current values but exposes no enabled mutation path; denied/unavailable Shell targets never load CRM private code.
- [x] Successful edit updates the exact Contact-detail cache, announces success, and navigates to the localized existing Contact-detail page; Back and Cancel use that destination without mutation.
- [x] Czech and English catalogs have matching `contactEdit` keys and no user-facing or accessibility text is hardcoded in application TSX.
- [x] Focused CRM/Shell/browser tests and the real BFF/Action integration suites prove frontend behavior and governed Contact editing without weakening deployment seams.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate existing Contact Action/API schemas, generated contracts, client exports, and CRM unit behavior.
- `mise exec -- pnpm --filter @app/crm test:component` — validate ContactEdit routing, query, form reuse, typed mutation, idempotency, cache, localization, navigation, and accessibility behavior, plus ContactForm regression coverage.
- `mise exec -- pnpm --filter @app/crm test:integration` — prove the generated clients reach the governed Contact Read and `EditContactAction` through the real strict BFF with idempotency, persistence, evidence, lifecycle/parent preservation, typed failures, and isolation.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate ContactEdit page, ContactForm props, typed client errors, route/target props, and federation declarations.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Shell exact-target resolution, ordered bounded route params, approved remote props, and authorization-before-load ordering.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e --grep "Contact edit|CRM"` — run localized anonymous/authenticated Contact-edit, BFF request, navigation, keyboard, and responsive browser coverage.
- `mise exec -- pnpm i18n:boundaries` — validate CRM-owned Czech/English copy and namespace boundaries.
- `mise exec -- pnpm api:check` — enforce strict Effect BFF topology and prevent forbidden frontend/backend API paths.
- `mise exec -- pnpm database-access:check` — retain owner-local governed Contact persistence and prevent database capabilities from reaching the page or Action handler.
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

## Implementation Evidence

### Summary

- Generated and implemented the private CRM Contact-edit page, exact Shell connector, Module Federation exposure, localized UI states, Contact loading/parent validation, reusable form composition, governed edit mutation, logical idempotency, cache update, and localized navigation.
- Added focused CRM component, Shell unit, browser, and generator regression coverage.

### Changed Files

- 16 tracked files changed: 614 insertions and 132 deletions; 8 new files add the owner/Shell route, federation wrapper, component tests, and this specification.

### Tests Written or Updated

- `verticals/crm/tests/components/contact-edit-page.test.tsx` — route validation, query/error states, form prefill, read-only behavior, mutation typing, idempotency, cache, localization, navigation, accessibility, and architecture boundaries.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` and `page.test.tsx` — exact target gating, ordered bounded route parameters, and resolved target propagation.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — anonymous privacy, Czech/English prefill, strict BFF requests, keyboard submission, uncertain retry, navigation, and 375 px layout.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — extending an existing dynamic route branch beside a static sibling.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 20 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 184 tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 3 real BFF/Action/database tests with the local governed test environment configured.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 162 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e --grep "Contact edit|CRM"` — passed, 3 Chromium tests.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm database-access:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm --filter @app/crm build` — passed with the worktree's immutable source revision supplied to the release-envelope build.
- `mise exec -- pnpm check` — passed.
- `mise exec -- pnpm build` — passed for CRM, Shell, Module Federation types, deployment output, and performance readiness with the immutable source revision supplied.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — passed, 37 tests.

### Review

- Reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, the specification, MicroVertical, Action, Effect error, data-access, module-entrypoint/manifest, UltraModern, frontend, Figma, and UI-kit guidance.
- Confirmed no direct fetch, backend/Action/persistence import, cross-vertical private import, ContactForm modification, plain CSS, token override, or navigation contribution was introduced.
- Fixed the generator's existing-dynamic-branch collision handling, separated safe read-retry copy from uncertain mutation copy, formatted generated registration files, and resolved all lint findings.
- Browser review screenshot: `.codex/reports/review/feature-crm-contact-edit-page/contact-edit-mobile.png`.

### Deviations and Follow-ups

- The mandatory generator initially rejected extending the existing `[contactId]` branch because it treated the pre-existing `new` sibling as a new collision. The generator was corrected with focused regression coverage before rerunning it successfully. No follow-up remains.

## Notes

- Stable generator identity is lower-kebab `contact-edit`, producing `ContactEditPage`; the locale is router-owned, so Codesmith receives `/crm/customers/:id/contacts/:contactId/edit`, not the `/cs` URL.
- `EditContactAction`, `editContact`, `getContact`, the Contact DTO/schemas, and real BFF/Action integration coverage are already implemented. This feature adds only the governed page and frontend integration; no new Action, API, persistence, or database work is planned.
- The existing `ContactForm` was explicitly approved and implemented by the Contact-create feature for create/edit reuse. Reusing it resolves component strategy and avoids a new business-file decision; no change to the form is currently required.
- The route Customer ID is hierarchical navigation context and a defensive parent-consistency check. `EditContactPayloadSchema` intentionally contains only `contactId`, `name`, `email`, and `phone`; `EditContactAction` preserves the immutable Customer parent and archive marker.
- Back, Cancel, and successful save conservatively return to the existing localized Contact-detail route because it is the closest stable view of the edited record.
- A successful Contact detail has no separate empty-data state. A legacy record with empty communication values is a ready form state, but current Action-aligned form validation requires valid values before saving.
- Query keys may be declared page-locally using the existing exact Contact-detail tuple. Do not introduce a new shared query-key file or import an entire sibling page module solely to share a trivial pure tuple.
- Figma source was inspected in the local view-only `ERP` file on `Pre-Alpha Repo`; the visible `Resource Detail — Běžný` arrangement and its known frame identity were confirmed. Connector metadata hit the Professional View-seat call limit, so no hidden component properties are assumed. This does not block implementation because project rules use Figma only as an arrangement wireframe.
- Product documentation places Contacts/CRM basics in August and describes later Contact reuse, while app-local implementation assigns this slice to `crm.core`. The app-local manifest and guidance are authoritative.
- No unresolved decision blocks implementation.
