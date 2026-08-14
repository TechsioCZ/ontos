---
type: feature
status: planned
created: 2026-08-14
---

# Feature: CRM Customer edit page

## Feature Description

Add the generated CRM `CustomerEdit` page at localized URL
`/cs/crm/customers/:id/edit` (canonical generator URL `/crm/customers/:id/edit`). The authenticated
Shell continues to own dashboard/sidebar composition and exact page gating. The remote CRM page
uses the route Customer ID to load the current Customer through the contract-derived CRM Effect BFF
client, renders a reusable Customer form, and submits the changed name through the generated
`editCustomer` client method so the final state change executes `EditCustomerAction` through the
CRM BFF.

Use Figma page `Pre-Alpha Repo`, screen `Resource Detail - Běžný`, only as a wireframe: preserve the
back-link, heading, and primary content arrangement, and replace the read-only detail rows with form
controls. Do not copy Figma styling or add inert resource-detail tabs. Use the installed
`@techsio/ui-kit` `FormInput`, `Button`, `Link`, and `StatusText` components with existing tokens and
Tailwind only for responsive layout composition.

The form itself must be a separate owner-private `CustomerForm` presentation component so a future
Customer-create page can reuse the same field, validation, pending, form-status, cancel, and submit
contract. It receives plain values/states and semantic callbacks; it does not read route params,
navigate, call the BFF, run Effects, access permissions, or depend on BFF/domain error types.

## User Story

As an authenticated CRM user with write access
I want to edit a Customer's name on a dedicated localized page
So that I can correct the canonical Customer record through the governed CRM Action boundary

## Problem Statement

CRM has persistence and a planned typed Customer read/edit BFF, but no user-facing edit route. The
mandatory page generator cannot currently express the requested dynamic URL, and frontend code must
not bypass the generated page entrypoint or call a backend handler/ad hoc fetch. The form also needs
an explicit reusable presentation boundary or a future create flow would duplicate validation and
UI behavior.

## Solution Statement

After dynamic page support and the existing Customer operations plan are implemented, run the
mandatory page generator with stable identity `customer-edit` and canonical URL
`/crm/customers/:id/edit`. Adapt only the generated owner page and wiring. Pass the declared `id`
route parameter to CRM feature integration, use the generated `getCustomerDetail` Effect client to
obtain initial values, and use a scoped TanStack Query integration (added to the CRM package) for
explicit loading, retry, not-found, forbidden, unavailable, and success states without ordinary
fetching in a React effect.

Render the owner-private `CustomerForm` with the one authoritative Customer business field,
`name`. Validate a trimmed non-empty name, preserve accessible field/form errors, and submit through
`editCustomer` with one idempotency key per logical submission. Exhaustively map the typed client
error union before rendering. On success, update/invalidate the cached Customer detail and navigate
to the localized generated Customers list without changing `CustomerForm`.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — `app/`-only scope and mandatory page generator rule.
- `AGENTS.md` — authoritative frontend, MicroVertical, BFF, Effect error, module-entrypoint, and generator constraints.
- `README.md` — generated page, Module Federation, strict Effect BFF, and toolchain conventions.
- `docs/frontend/FRONTEND.md` — route/feature versus presentation ownership, explicit UI states, i18n, React 19, and UI-kit rules.
- `docs/frontend/FIGMA.md` — Figma is arrangement-only; UI-kit components remain the visual source of truth.
- `docs/architecture/MICROVERTICALS.md` — CRM frontend/backend virtual seam and generated BFF client requirement.
- `docs/architecture/ERRORS.md` — typed BFF error preservation and exhaustive UI mapping.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact page resolution, write availability, and private remote-load ordering.
- `docs/architecture/ULTRAMODERN.md` — Effect-first behavior and generated business-artifact rules.
- `specs/chore-support-dynamic-microvertical-pages.md` — prerequisite generator/Shell support for `/crm/customers/:id/edit` and route-param props.
- `specs/feature-crm-customer-contact-actions.md` — prerequisite `getCustomerDetail` and `editCustomer`/`EditCustomerAction` BFF contracts, DTO, typed errors, authentication, and idempotency behavior.
- `specs/feature-crm-customers-list-page.md` — prerequisite generated `/crm/customers` destination and CRM-owned UI-kit, TanStack Query, and Rstest component-test infrastructure to reuse.
- `verticals/crm/package.json` — reuse the direct UI-kit, TanStack Query, and focused component-test dependencies/scripts established by the Customers list feature.
- `verticals/crm/src/routes/index.css` — already imports UI-kit tokens/theme and the CRM Tailwind source; no visual override is planned.
- `verticals/crm/src/api/crm-client.ts` — generated Effect BFF methods used exclusively by feature integration.
- `verticals/crm/shared/api.ts` — canonical Customer DTO/input and typed public error contracts; presentation must not import them.
- `verticals/crm/src/routes/[lang]/crm/customers/page.tsx` — generated Customers list route used by Back/Cancel and post-save navigation.
- `verticals/crm/vertical.manifest.ts` — generated exact page contribution; dynamic page must not appear in navigation.
- `verticals/crm/vertical.registration.ts` — generated owner-private lazy page registration.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell passes `target.writable` and declared route params into the approved remote.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated exact CustomerEdit remote client registration and prop contract.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — generated `CustomerEditPage` route/feature integration, typed BFF query/mutation orchestration, explicit UI states, and navigation.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/edit/route.meta.ts` — generated private/non-indexable dynamic route metadata.
- `verticals/crm/src/features/customers/customer-form.tsx` — owner-private reusable presentation component for edit and future create flows; creation is blocked until an approved Codesmith starting point is selected.
- `verticals/crm/src/federation/page-customer-edit.tsx` — generated localized Module Federation wrapper accepting declared route params.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/edit/page.tsx` — generated authenticated Shell connector.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/edit/page.data.ts` — generated exact-target loader carrying only declared route params.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/edit/route.meta.ts` — generated Shell-side private route metadata.
- `verticals/crm/tests/components/customer-form.test.tsx` — reusable form contract, validation, keyboard, focus, pending, and accessibility tests.
- `verticals/crm/tests/components/customer-edit-page.test.tsx` — route-param, BFF query/mutation, idempotency, typed state mapping, write availability, and navigation tests.

## Implementation Plan

### Phase 1: Foundation

Complete `specs/chore-support-dynamic-microvertical-pages.md`,
`specs/feature-crm-customer-contact-actions.md`, and
`specs/feature-crm-customers-list-page.md`. Then generate `customer-edit` at the canonical
parameterized URL before adapting any page/wiring file. Reuse the list page's CRM-owned UI/query/test
infrastructure. Resolve the mandatory Codesmith decision for the new private reusable presentation
file before creating `customer-form.tsx`.

### Phase 2: Core Implementation

Implement `CustomerForm` as a controlled presentation contract using `FormInput`, primary/secondary
`Button`s, and `StatusText`, with no routing, BFF, Effect, or permission dependency. Adapt the
generated CustomerEdit page to load current values through `getCustomerDetail`, preserve the typed
client error union at the query edge, gate editing on `target.writable`, and submit through
`editCustomer` with correct idempotency and retry behavior.

### Phase 3: Integration

Complete English/Czech copy, generated manifest/registration/federation/Shell wiring, responsive and
accessible state rendering, post-save navigation, focused component/feature tests, exact contract
checks, and the independent CRM build. Keep the real Action/BFF proof in the prerequisite CRM
integration suite until repository browser orchestration can start both deployments.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the dynamic CustomerEdit page

- [ ] Confirm `specs/chore-support-dynamic-microvertical-pages.md` is implemented, then from `app/` run the mandatory Codesmith command `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customer-edit --url /crm/customers/:id/edit` before authoring or adapting any CustomerEdit route, metadata, manifest, registration, federation, Shell connector, locale, or lazy-client file.
- [ ] Inspect the complete generated mutation set. Retain `crm.core.page.customer-edit`, tenant `page`/`read` ownership, private/non-indexable metadata, `[lang]/crm/customers/[id]/edit` filesystem routing, exact canonical template, no dynamic navigation item, generated locale keys, owner-private registration, Module Federation exposure, and exact Shell lazy-client identity.

### 2. Resolve and use an approved reusable-form starting point

- [ ] Before creating `verticals/crm/src/features/customers/customer-form.tsx`, obtain the developer's decision on an approved Codesmith starting point for owner-private reusable presentation components. Do not misuse `scaffold:public-component`, which would publish an internal form as a Shell entrypoint, and do not create the business file manually while `docs/architecture/ULTRAMODERN.md` forbids unsupported business-file types.
- [ ] After the approved generator exists or the developer explicitly approves a documented alternative, run that starting point first and adapt its output into `CustomerForm`. Record the exact command in this plan/evidence before implementation proceeds.

### 3. Reuse CRM frontend data and test infrastructure

- [ ] Verify the completed Customers list prerequisite established direct CRM dependencies `@techsio/ui-kit@0.25.1` and `@tanstack/react-query@5.101.4`, plus its compatible Rstest/Testing Library/happy-dom dev dependencies and `test:component` script. Reuse those exact package/runtime contracts; do not add a second query library, provider abstraction, or duplicate test setup.
- [ ] Create one stable page-local Query client/provider in the generated CustomerEdit module, following the Customers list pattern, so query/mutation integration works in standalone and federated rendering without creating Promises during render or fetching in a React effect. Set bounded retry behavior from each operation's typed error union.
- [ ] Keep UI-kit tokens/theme in the existing CRM stylesheet and add no app/component token override unless implementation proves a real token gap.

### 4. Implement and test the reusable CustomerForm presentation

- [ ] Define a plain presentation contract with initial/current `{ name: string }` values, localized labels/action copy supplied by the owning feature, pending/disabled state, optional name error and form status, `onSubmit(values)`, and `onCancel()` callbacks. Do not import route, query, BFF, Effect, permission, Customer DTO, or client-error types.
- [ ] Compose `@techsio/ui-kit/molecules/form-input` for the required Customer name, `Button` for submit/cancel actions, and `StatusText` for short form-level status. Use component props/tokens for appearance and Tailwind only for responsive form/action layout; do not add native/custom input/button primitives, plain CSS, Figma colors, duplicated token classes, tabs, or a new UI-kit component.
- [ ] Normalize the submitted name with the same trimmed non-empty rule as the Action contract, show localized inline validation, set `aria-invalid`/descriptions through `FormInput`, focus the first invalid field, support Enter submission, disable duplicate submission while pending, expose localized loading text, and keep Cancel mutation-free.
- [ ] Add `customer-form.test.tsx` proving edit initial values, future-create empty initial values, change emission, whitespace validation, keyboard submission, invalid focus, one semantic submit per intent, pending/loading/disabled behavior, cancel callback, server-supplied field/form errors, accessible names/descriptions/live status, and absence of application/BFF dependencies.

### 5. Load and render Customer edit states through the BFF

- [ ] Adapt only the generated `CustomerEditPage` route/feature file to accept `routeParams.id` plus the resolved target. Validate presence of the generated parameter and call only `getCustomerDetail({ customerId: id })` through the generated CRM Effect client inside a typed TanStack query adapter; do not import a handler, use `fetch`, access persistence, or collapse failures to `unknown`.
- [ ] Map the full query error union to explicit localized loading, ready, not-found, forbidden, unavailable/retry, and sanitized unexpected states before rendering. Do not treat not-found/forbidden/structural input failures as retryable; bound retries for transport/declared temporary unavailability and expose a semantic Retry action.
- [ ] When the Shell target reports `writable: false` for `read_only`/`deprecated` module state, keep the page readable but do not render an enabled mutation path; show the localized read-only explanation. An unavailable or denied write capability must never be guessed into an enabled form.
- [ ] In the ready state, follow the `Pre-Alpha Repo` / `Resource Detail - Běžný` arrangement: localized Back-to-CRM link, Customer edit heading, and the form in the main content region replacing detail rows. Use current Customer name as initial value, retain Shell/sidebar composition outside the remote, omit nonfunctional tabs, and make the layout usable from narrow mobile width through the Figma desktop reference.

### 6. Submit EditCustomerAction through the generated CRM BFF client

- [ ] On valid submit, call `editCustomer({ customerId: id, name })` through the generated CRM client and action gateway. Generate one idempotency key for each logical submission; reuse that key only when explicitly retrying an uncertain same-payload attempt, and create a new key after the user changes the intent/payload.
- [ ] Preserve and exhaustively map validation/field issues, authentication, forbidden/module write denial, not found, idempotency/current-state conflict, retryable transport/infrastructure unavailability, decoding failure, and sanitized unexpected failure. Feed field/form presentation state into `CustomerForm`; never expose internal diagnostics or let an expected client error escape as an untyped rejection.
- [ ] On success, update or invalidate the Customer-detail query, announce localized success accessibly, and navigate with the localized router to the generated Customers list `/crm/customers`. Cancel and the Figma-style back link also return to that route without calling the mutation.

### 7. Complete i18n and focused feature tests

- [ ] Replace the generated starter copy and add every visible/accessibility string under CRM-owned `cs` and `en` catalogs: title, Back/Cancel, Customer-name label, Save/Saving, required validation, loading, read-only, forbidden, not found, conflict, unavailable/retry, generic failure, and success. Keep route metadata private/non-indexable and user-facing text out of TSX/configuration.
- [ ] Add `customer-edit-page.test.tsx` with mocked contract-derived Effect clients and a real query provider. Prove exact `id` propagation, initial detail loading, form prefill, retry classification, every explicit UI state, `target.writable` gating, successful payload/idempotency propagation, uncertain retry key reuse, changed-intent key renewal, no mutation on Back/Cancel, cache update/invalidation, localized navigation, and no direct fetch/backend import.
- [ ] Extend generator/module-entrypoint contract tests only where the production CustomerEdit output needs exact assertions. Keep the complete real Action/BFF persistence proof in the prerequisite CRM integration suite; do not add a Shell-only browser test that mocks or bypasses the independently deployed CRM remote/BFF.

### 8. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without adding a Customer list/create page, extra Customer fields, a new UI-kit component, token overrides without a proven gap, ad hoc fetches, Shell business logic, direct backend imports, or unrelated CRM behavior.

## Testing Strategy

### Unit Tests

Use focused Rstest/Testing Library coverage for the reusable `CustomerForm` contract and
CustomerEdit integration. Exercise accessible validation/focus/keyboard behavior, initial query
states, `target.writable`, exhaustive typed query/mutation error mapping, exact BFF payload and
idempotency behavior, cache/navigation results, and the form's lack of routing/BFF dependencies.
Retain the existing CRM Node unit suite for schemas/contracts and extend generated page/manifest
assertions only where necessary.

### Integration Tests

Rely on `specs/feature-crm-customer-contact-actions.md` for real Action/Read runtime and strict BFF
integration. A new Playwright integration test is not required in this increment because the
researched browser configuration starts only the Shell command and does not orchestrate the
independently deployable CRM remote/BFF. Focused UI tests cover page interaction while the
prerequisite real-BFF suite proves durable reads/writes; add a cross-deployment browser proof later
when repository-owned orchestration exists rather than mocking or weakening the seam.

### Edge Cases

- The route `id` parameter is missing, malformed, not found, or belongs to another tenant.
- Initial detail authentication is missing/expired, permission is denied, or transport/decode/infrastructure is unavailable.
- CRM is `active`, `read_only`, `deprecated`, inactive, or its state check is unavailable.
- The Customer is active or archived; the planned Edit action preserves archive state.
- The name is unchanged, empty, whitespace-only, padded, or changed while a previous attempt is uncertain.
- The same logical submit is retried after uncertain failure versus a new payload requiring a new idempotency key.
- Edit succeeds, conflicts, becomes not found, or is denied after the initial detail was loaded.
- Back/Cancel is used before and after local edits and never invokes the Action.
- The page is used at mobile width, desktop width, by keyboard only, and with status announcements.
- A future create page supplies empty initial values and a different submit label/callback to the same `CustomerForm` without route/BFF coupling.

## Acceptance Criteria

- [ ] The generated private page is reachable at `/cs/crm/customers/:id/edit` and `/en/crm/customers/:id/edit`, with canonical generator URL `/crm/customers/:id/edit`, after authenticated exact-page resolution.
- [ ] The dynamic page is registered in the CRM manifest/registration/federation/Shell client but is not emitted as an ordinary navigation href.
- [ ] Current Customer data is loaded only through the generated `getCustomerDetail` Effect BFF client and every typed failure maps to an explicit localized UI state.
- [ ] The form is a separate reusable owner-private `CustomerForm` presentation component with plain values/states/callbacks and no route, query, BFF, Effect, permission, or navigation dependency.
- [ ] `CustomerForm` uses existing UI-kit `FormInput`, `Button`, and `StatusText` APIs/tokens, supports future create initial values, and adds no new UI-kit component or unproven visual override.
- [ ] Figma `Pre-Alpha Repo` / `Resource Detail - Běžný` influences arrangement only: Shell/sidebar, back link, heading, and main content are preserved while detail rows become inputs; styling remains UI-kit-owned and no inert tabs are added.
- [ ] Valid submission calls generated `editCustomer`, which invokes `EditCustomerAction` through the CRM BFF with Customer ID, normalized name, fresh assertion, correlation metadata, and correct idempotency semantics.
- [ ] Validation, forbidden, not-found, conflict, unavailable/retry, decode/transport, and unexpected mutation outcomes remain typed until mapped to accessible field/form/page states.
- [ ] `read_only`/`deprecated` CRM remains readable but exposes no enabled save path; inactive/denied/unavailable targets fail closed.
- [ ] Successful edit updates/invalidate cached detail, announces success, and navigates to the localized generated Customers list; Back/Cancel never mutates.
- [ ] English and Czech catalogs contain every visible and accessible string, and the route remains private/non-indexable.
- [ ] Focused UI tests prove page/form behavior and the prerequisite real BFF integration suite proves governed Customer read/edit behavior without weakening deployment seams.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate existing CRM schemas/contracts plus generated Customer operation/page contracts.
- `mise exec -- pnpm --filter @app/crm test:component` — validate `CustomerForm` and CustomerEdit query/mutation/accessibility behavior in Rstest.
- `mise exec -- pnpm --filter @app/crm test:integration` — prove the real governed Customer read/edit BFF, idempotency, evidence, RLS, and typed failures used by the page.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate CRM page, form, query, BFF client, route-param, and generated federation types.
- `mise exec -- pnpm i18n:boundaries` — validate complete CRM-owned English/Czech copy and namespace ownership.
- `mise exec -- pnpm api:check` — enforce that page reads/writes use the strict generated Effect BFF topology.
- `mise exec -- pnpm module-entrypoints:check` — validate exact generated page gating, private lazy registration, and absence of raw remote loads.
- `mise exec -- pnpm check:module-contracts` — validate the CRM manifest, dynamic non-navigation page contribution, and owner registration.
- `mise exec -- pnpm --filter @app/crm build` — compile the independently deployable CRM page, UI-kit/query integration, BFF client, and Module Federation exposure.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Shell route-param propagation and exact approved remote integration.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Implementation order is: dynamic page generator chore; existing Customer Action/Read/BFF feature;
  generated Customers list page; then this page feature.
- Stable generator identity is lower-kebab `customer-edit`, producing `CustomerEditPage`; the locale
  is router-owned, so the generator receives `/crm/customers/:id/edit`, not `/cs/...`.
- Customer has exactly one editable business field, `name`, under the completed persistence contract.
- The concurrently planned generated Customers list page owns `/crm/customers`; this feature depends
  on it for a concrete, localized Back/Cancel/success destination and reuses its CRM UI/query/test
  setup.
- TanStack Query is selected because the remote page is lazy-loaded inside the authenticated Shell,
  the current gateway does not execute an owner route loader, and frontend guidance forbids ordinary
  route fetching in a React effect. The query adapter remains the thin Promise edge around typed
  CRM client Effects.
- Blocking developer decision: `docs/architecture/ULTRAMODERN.md` forbids manually creating a new
  business-functionality file type, but the repository has no approved generator for an owner-private
  reusable presentation component. Before implementation, approve a Codesmith generator/extension
  for `CustomerForm` or explicitly approve another compliant starting point. The public-component
  generator is not suitable because the form must remain private to CRM.
- Follow-up: the current Playwright server starts only the Shell command. Add a cross-deployment
  browser proof after repository-owned orchestration supplies the independently deployable CRM
  BFF/remote; do not weaken the deployment seam or silently replace that proof with a mocked browser
  request.
