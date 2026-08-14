---
type: feature
status: planned
created: 2026-08-14
---

# Feature: CRM Customer detail page

## Feature Description

Add the generated CRM MicroVertical page `CustomerDetail` at canonical route
`/crm/customers/:id`, exposed by the locale-aware Shell as `/cs/crm/customers/:id` and
`/en/crm/customers/:id`. The authenticated page presents one Customer using the component
arrangement from Figma page `Pre-Alpha Repo`, frame `Resource Detail — Běžný` (`6:780`): a compact
return link, Customer heading, and responsive overview details inside the existing Shell dashboard
layout.

The page must obtain its Customer data by executing the CRM contract-derived
`getCustomerDetail` Effect client operation through the CRM BFF. It must not import a backend
handler, read CRM persistence directly, or issue an ad hoc `fetch`. The BFF operation is owned by
the prerequisite plan `specs/feature-crm-customer-contact-actions.md`; this page consumes that
operation and does not create a second Customer-detail contract or endpoint.

Figma is a wireframe for arrangement only. The implementation uses the installed
`@techsio/ui-kit` components and tokens without copying Figma colors, spacing, typography, borders,
or component styling.

## User Story

As a signed-in CRM user
I want to open a Customer by its URL and see its current details
So that I can inspect the canonical CRM record without leaving the authenticated dashboard

## Problem Statement

CRM persists Customers and has a planned governed Customer-detail read, but it has no Customer
detail page. Users therefore cannot navigate directly to a Customer record through a stable,
localized CRM URL or see typed loading, not-found, forbidden, and unavailable states.

The current repository cannot safely generate the requested page yet. The mandatory
`scaffold:microvertical-page` command rejects route parameters, `ShellPageContributionSchema`
accepts only static kebab-case paths, and the generated Shell page connector has no approved typed
route-parameter prop contract for a remote MicroVertical page. Hand-authoring
the dynamic route, manifest registration, Shell connector, or private loader would violate the
Codesmith and module-entrypoint rules. The planned prerequisite
`specs/chore-support-dynamic-microvertical-pages.md` owns that infrastructure change.

## Solution Statement

First implement and validate `specs/chore-support-dynamic-microvertical-pages.md`. After that
prerequisite lands, run the page generator with stable page identity `customer-detail` and canonical URL
`/crm/customers/:id`; do not include the locale in the generator URL.

Adapt the generated CRM page to receive the bounded `id` route prop only after the Shell gate,
validate it as the Customer UUID, and call `getCustomerDetail` through the CRM Effect BFF client.
Follow the Customers-list feature's page-local TanStack Query pattern to bridge the typed Effect at
the framework edge without ordinary fetching in a React effect. Retain the declared
client error union until it is mapped to a closed presentation model. Use UI-kit `Link`, `Skeleton`,
`StatusText`, and `Button` components for navigation, loading, feedback, and retry. Render the
Customer fields as a semantic description list because the UI kit has no more specific detail-list
component. Do not add inert tabs for Documents, Timeline, or Audit: those peer panels are visible in
the generic Figma wireframe but have no CRM contract in this feature.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory MicroVertical page generator rule.
- `AGENTS.md` — authoritative MicroVertical, Effect, module-entrypoint, frontend, and toolchain constraints.
- `README.md` — current page generator, localized routing, private Shell gateway, and strict Effect BFF conventions.
- `package.json` — supported generator, test, typecheck, i18n, contract, and final quality commands.
- `docs/architecture/MICROVERTICALS.md` — generated CRM BFF client seam and prohibition on frontend backend imports or ad hoc fetches.
- `docs/architecture/ERRORS.md` — typed BFF failure and frontend error-state requirements.
- `docs/architecture/DATA_ACCESS.md` — governed Customer read lifecycle and trusted-context boundaries.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — page gate ordering and lazy private implementation rules.
- `docs/architecture/MODULE_MANIFESTS.md` — page identity, canonical URL, locale ownership, and generator order.
- `docs/architecture/ULTRAMODERN.md` — Effect-first behavior and prohibition on manually creating generated business artifacts.
- `docs/frontend/FRONTEND.md` — route-level data, view-model, UI-kit, i18n, accessibility, and responsive rules.
- `docs/frontend/FIGMA.md` — requires treating Figma as an arrangement wireframe and retaining UI-kit visuals.
- `specs/chore-support-dynamic-microvertical-pages.md` — prerequisite generator, route-template schema, non-navigation rule, authenticated route-param boundary, and regression coverage for dynamic MicroVertical pages.
- `specs/feature-crm-customer-contact-actions.md` — prerequisite owner of `getCustomerDetail`, its DTO, typed errors, authenticated BFF endpoint, and generated client method.
- `specs/feature-crm-customers-list-page.md` — prerequisite owner of `/crm/customers`, the return destination, and CRM-local UI-kit/query dependencies and test infrastructure reused by this page.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — current mandatory page generator and static-only URL parser that blocks this route.
- `scripts/scaffolding/shared.mts` — page scaffold configuration and result types affected by an approved dynamic-page extension.
- `scripts/scaffolding/cli.mts` — current page CLI contract and help output.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-workspace proof required for dynamic route generation, collisions, reruns, and atomic failure.
- `packages/core-runtime/src/modules/shell-contribution.ts` — current static-only Shell page contribution route schema.
- `verticals/crm/package.json` — CRM dependencies and focused validation scripts; currently does not declare `@techsio/ui-kit`.
- `verticals/crm/src/routes/index.css` — CRM-prefixed Tailwind and shared-token setup that must gain an approved UI-kit consumer integration without copying Figma styles.
- `verticals/crm/shared/api.ts` — aggregate CRM BFF contract after the prerequisite backend feature is implemented.
- `verticals/crm/src/api/crm-client.ts` — required contract-derived `getCustomerDetail` client method.
- `verticals/crm/vertical.manifest.ts` — generated Customer-detail page contribution and component slots.
- `verticals/crm/vertical.registration.ts` — generated owner-private lazy page registration.
- `verticals/crm/module-federation.config.ts` — generated page exposure and CRM dependency-sharing context.
- `verticals/crm/src/federation-entry.tsx` — CRM CSS entry and existing generated federation surface.
- `verticals/crm/src/i18n/resources.ts` — makes Czech and English Customer-detail copy available inside the federated page boundary.
- `verticals/crm/locales/cs/crm.json` — Czech page, field, loading, failure, retry, and navigation copy.
- `verticals/crm/locales/en/crm.json` — English counterpart for every new CRM key.
- `apps/shell-super-app/shared/api.ts` — resolved page-target contract currently lacking route parameters.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated approved lazy page registry and component contract.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — authenticated exact-page gate and serializable route model to preserve.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — Shell dashboard wrapper that must not load the remote page or its data before resolution.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — exact generated connector and pre-gate behavior coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — private lazy-load ordering and remote prop contract coverage.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — existing authenticated localized CRM browser flow to extend for Customer detail.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx` — generated Customer-detail page adapted to render the closed page model with UI-kit components.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/route.meta.ts` — generated private, non-indexable dynamic CRM route metadata.
- `verticals/crm/src/federation/page-customer-detail.tsx` — generated federated CRM page boundary.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/page.tsx` — generated Shell connector that renders only the approved Customer-detail remote.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/page.data.ts` — generated Shell connector loader that carries only the declared `id` route parameter after the authenticated exact-page gate.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/route.meta.ts` — generated localized Shell route metadata.
- `verticals/crm/tests/components/customer-detail-page.test.tsx` — route parameter, BFF query, presentation-state, localization, semantics, retry, and responsive coverage that mocks only the frontend client seam.

## Implementation Plan

### Phase 1: Foundation

Implement and validate the planned dynamic-page chore, then run the mandatory page generator.
Complete the Customer operations plan so `getCustomerDetail` and its public DTO/error union are real
contracts rather than page-owned inventions. Complete the Customers-list page so `/crm/customers`
and the CRM-local UI-kit/query dependencies and test infrastructure exist before detail reuses them.

### Phase 2: Core Implementation

Adapt the generated remote route-param prop to validate `id`, execute `getCustomerDetail` through the
CRM Effect client inside the CRM query boundary, and map success and the complete client error union
to closed presentation states.
Adapt the generated page presentation to show the Customer name and canonical DTO fields with
localized labels, layout-only Tailwind classes, UI-kit loading/error/retry controls, semantic HTML,
and no mutation affordances.

### Phase 3: Integration

Verify that Shell authentication, legal-entity selection, module state, and page permission gates
run before any CRM remote or Customer read. Add focused generator, contract, Shell, and browser
coverage for both locales, exact Customer ID propagation, normal/loading/not-found/forbidden/
unavailable behavior, retry, and mobile layout. Finish with the complete repository quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Complete dynamic-page support and generate the Customer-detail page

- [ ] Implement `specs/chore-support-dynamic-microvertical-pages.md` first and verify all of its acceptance criteria. The generator must map canonical `:id` to `[id]`, omit dynamic templates from ordinary navigation, and pass only the declared bounded route parameter to the approved remote after every authenticated exact-page gate. Do not hand-author the CRM route or loader as a workaround.
- [ ] Once that prerequisite is present, make the first Customer-detail artifact change by running `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customer-detail --url /crm/customers/:id` from `app/`. The command must generate the vertical page, Shell connector, route metadata, locales, manifest/registration slots, Module Federation exposure, and approved client registry atomically.
- [ ] Inspect the generator result before adapting it: page identity is `crm.core.page.customer-detail`; canonical route is `/crm/customers/:id`; Czech and English runtime URLs add only `/cs` and `/en`; filesystem paths use `[id]`; the page is private/non-indexable; no private implementation or Customer BFF call can run before the Shell resolves the exact page target.

### 2. Complete and verify the Customer-detail BFF prerequisite

- [ ] Implement `specs/feature-crm-customer-contact-actions.md` before this page, or verify that its acceptance criteria already pass. Require the browser-safe Customer DTO (`customerId`, `name`, ISO `createdAt`/`updatedAt`, nullable ISO `archivedAt`), the authenticated governed read, and the contract-derived `getCustomerDetail` Effect client method.
- [ ] Do not add another Customer-detail endpoint, request/response schema, persistence service, or client wrapper in the page change. The page must import only the browser-safe generated CRM client and DTO/error contracts; it must never import `api/**`, `src/db/**`, a read handler, or a database service.
- [ ] Complete `specs/feature-crm-customers-list-page.md` before this page, or verify that its acceptance criteria already pass. Reuse its generated `/crm/customers` route, UI-kit/query dependencies, CSS consumer setup, and focused component-test infrastructure instead of installing or configuring parallel copies.

### 3. Verify and reuse CRM UI-kit/query consumption without Figma styling

- [ ] Verify the Customers-list prerequisite has added `@techsio/ui-kit@0.25.1`, TanStack Query, and focused CRM component-test dependencies without duplicating or upgrading them. Verify actual `0.25.1` component props before use because the local intent-skill metadata describes a different library release.
- [ ] Reuse the approved Module Federation/Tailwind integration so `Link`, `Skeleton`, `StatusText`, and `Button` render correctly both inside the Shell and when CRM runs independently. Preserve the existing `crm:` namespace for CRM-authored layout utilities, reuse UI-kit defaults and semantic tokens, and add no Figma-derived raw colors, spacing, typography, borders, radius, or component overrides.
- [ ] If the existing prefixed CRM Tailwind build cannot compile the UI kit's unprefixed utility classes without duplicate or host-only CSS, stop and obtain an approved framework-consumer solution; do not copy UI-kit classes or styles into CRM.

### 4. Load one Customer through the generated BFF seam

- [ ] In the generated CRM page integration, decode the required `routeParams.id` as the Customer UUID and construct only the declared Customer-detail request. Reject a missing, malformed, undecodable, or overlong ID locally as `not_found` without calling the BFF, and never treat it as trusted tenant, principal, legal-entity, or authorization context.
- [ ] Create a stable page-local TanStack Query client/provider and a query key containing the validated Customer ID, following the Customers-list page pattern. At the query-library adapter edge, execute `getCustomerDetail` through the generated CRM Effect client with its declared request/options contract. Keep the Effect success and error channels typed, preserve cancellation on navigation where the client supports it, and do not introduce `fetch`, a Promise-only client wrapper, backend imports, a global process cache, or a React effect for ordinary data fetching.
- [ ] Map the operation to a closed presentation model: `ready` with the Customer DTO; `not_found` for a malformed/absent Customer; `forbidden` for a definite BFF denial; `authentication_expired` for a post-load session failure; and `unavailable` with retry metadata for retryable backend, transport, decode, or sanitized internal failures. Shell authentication, legal-entity selection, module state, and exact-page permission failures remain Shell-owned and must prevent the CRM remote and query from loading.
- [ ] Ensure one successful page load invokes `getCustomerDetail` once with the exact URL Customer ID. Rely on the prerequisite Read runtime to commit its Data Access Event before releasing the result; the page must not write audit/evidence rows itself.

### 5. Implement the Customer-detail presentation from the wireframe arrangement

- [ ] Adapt the generated `CustomerDetailPage` to render a compact UI-kit `Link` back to the prerequisite localized `/crm/customers` route with copy such as “Back to Customers”; preserve the active locale and do not hardcode `/cs` or `/en`.
- [ ] Render the Customer name as the page content heading and a semantic `<dl>` overview with localized labels for Customer ID, lifecycle status derived from `archivedAt`, created time, and updated time. Render timestamps with `<time dateTime={...}>` and locale-aware formatting; render no fields that are absent from the prerequisite Customer DTO.
- [ ] Use the Figma frame only for the link → heading → overview ordering and compact key/value rhythm. Use UI-kit/default token visuals and CRM-prefixed responsive layout utilities. Do not add Documents, Timeline, Audit, Contacts, edit, archive, or restore controls, and do not render an inert `Tabs` component when only the overview panel has a contract.
- [ ] Keep the pure presentation portion free of BFF Effects, route hooks, raw DTO errors, and navigation commands. Keep query integration and presentation separate within the generated page module so no unsupported business file type is introduced; pass only the closed model and semantic retry callback into presentation.

### 6. Implement explicit loading, failure, retry, and responsive behavior

- [ ] Render a stable loading layout with UI-kit `Skeleton` parts that mirrors the heading and detail rows, includes an accessible busy announcement, and does not use custom pulse divs or Figma colors.
- [ ] Render localized UI-kit `StatusText` states for authentication expired, forbidden, not found, and unavailable. Authentication expiry and unavailable/retryable states expose a safe UI-kit `Button` retry action; a definite `403` does not imply retry will grant access. Keep the previous failed state visible while retrying and use `isLoading`/`loadingText` rather than a custom spinner.
- [ ] Treat “empty” as not applicable: a Customer-detail success always contains one decoded Customer, while absence is `not_found`. Validation and conflict states are also not applicable because this page performs no mutation. A `read_only` or `deprecated` module remains readable and exposes no write controls; inactive/suspended/quarantined/missing module states remain Shell-owned denial states and must not load CRM code.
- [ ] Preserve semantic heading order, keyboard-operable link/retry controls, visible focus behavior, `aria-live="polite"` for asynchronous feedback, and no horizontal overflow at 375 px. Let long Customer names and translated labels wrap without overlapping values or controls.

### 7. Complete localization and generated route metadata

- [ ] Replace the generated starter copy in both CRM locale catalogs with complete Czech and English Customer-detail title/description, back link, field labels, lifecycle values, loading, not-found, forbidden, authentication-expired, unavailable, retry, and retry-pending strings. Hardcode no visible or accessibility text in TSX.
- [ ] Keep both generated vertical and Shell route metadata private and non-indexable. Preserve canonical `/crm/customers/:id`; let the localized router add `/cs` or `/en`; do not add a literal locale to metadata, the BFF route, manifest contribution, or generated filesystem identity.

### 8. Add focused generator, contract, Shell, and browser tests

- [ ] Retain the prerequisite dynamic-page chore's disposable generator coverage; add only a focused exact-output assertion if this Customer-detail command exposes an uncovered generator defect. Do not duplicate the chore's route grammar, collision, rerun, or atomicity suite in this feature.
- [ ] Add `verticals/crm/tests/components/customer-detail-page.test.tsx` for route-ID decoding, exact `getCustomerDetail` BFF-client invocation, loading/ready/error/retry presentation, ISO timestamp/lifecycle view data, localization, semantic markup, and the absence of backend/database imports or a duplicate Customer-detail contract.
- [ ] Extend Shell loader/page unit tests to prove dynamic parameters are passed only after exact target resolution; anonymous/selection-required/forbidden/not-found/unavailable Shell states never load the remote and therefore cannot call `getCustomerDetail`; and a resolved target invokes the approved component exactly once with the declared Customer ID.
- [ ] Extend the Shell Playwright fixture and `login.spec.ts` with a deterministic tenant-visible Customer. Prove anonymous Czech/English direct URLs show no private Customer content; authenticated `/cs/crm/customers/<id>` and `/en/crm/customers/<id>` render the localized normal state and exact Customer fields; absent/forbidden/unavailable responses render the correct state and retry behavior; the request reaches the `getCustomerDetail` BFF endpoint with the URL ID; and the 375 px layout has no horizontal overflow.

### 9. Run all validation commands

- [ ] Execute every command in `Validation Commands` in order and resolve feature-related failures without adding manual generated artifacts, an alternative Customer endpoint, inert tabs, mutation controls, Figma styling, cross-vertical imports, or unrelated dependency upgrades.

## Testing Strategy

### Unit Tests

Rely on the dynamic-page prerequisite's disposable workspaces for filesystem mapping, route schema,
Shell/manifest wiring, collisions, reruns, and atomic failure. Use CRM component tests for route-ID
decoding, exact BFF request construction, query behavior, DTO-to-view mapping, typed failure mapping,
semantic presentation, localization, and source-boundary assertions. Use Shell Rstest coverage for
authorization-before-load ordering and the typed remote parameter contract.

### Integration Tests

Reuse the prerequisite CRM BFF integration coverage for governed Customer reads, authentication,
tenant isolation, typed Problem Details, and durable Data Access evidence. Add an authenticated
Shell browser flow with a seeded Customer to prove the complete localized URL → Shell gate →
generated remote route-param seam → `getCustomerDetail` BFF → rendered detail path. Browser tests also
cover anonymous non-loading, declared failures, retry, keyboard behavior, and mobile layout.

### Edge Cases

- The route parameter is missing, malformed, undecodable, overlong, or identifies no Customer.
- A valid Customer UUID belongs to another tenant and must not leak whether that record exists.
- The Customer is archived; detail remains readable and displays the archived lifecycle state.
- The CRM module is active, `read_only`, deprecated, inactive, suspended, quarantined, or unavailable.
- Authentication or selected legal-entity context changes while the dynamic page is open.
- The BFF returns declared `401`, `403`, `404`, retryable `503`, sanitized `500`, transport failure, or decode failure.
- Retry succeeds after an unavailable response, does not duplicate concurrent reads, and retains the exact Customer ID.
- Customer name or translated labels are long, timestamps cross locale/time-zone formatting boundaries, or the viewport is 375 px wide.
- The Customers-list prerequisite is unavailable; this detail feature must not land with a dead `/crm/customers` return link.

## Acceptance Criteria

- [ ] Codesmith, not hand-authored wiring, creates page identity `customer-detail` and the dynamic canonical route `/crm/customers/:id`; Czech and English URLs are `/cs/crm/customers/:id` and `/en/crm/customers/:id`.
- [ ] The authenticated Shell resolves the exact page and selects only its declared bounded route parameter before any private CRM remote or Customer BFF operation executes.
- [ ] A valid URL invokes the contract-derived CRM `getCustomerDetail` Effect client once with the exact Customer ID and uses no ad hoc fetch, backend import, or database access.
- [ ] The page reuses the Customer DTO/error contract from `specs/feature-crm-customer-contact-actions.md` and introduces no duplicate endpoint or schema.
- [ ] The normal state follows the Figma wireframe's link, heading, and overview arrangement while all visual styling comes from `@techsio/ui-kit` defaults/tokens and CRM layout utilities.
- [ ] The Customer name, ID, active/archived state, created timestamp, and updated timestamp render from real BFF data; no unsupported Customer field or inactive tab is invented.
- [ ] Loading, authentication-expired, forbidden, not-found, unavailable, retrying, and recovered states are explicit, localized, accessible, and covered by tests; Shell-owned selection/module denials never load the page, and no separate empty/validation/conflict state is fabricated for this read-only detail page.
- [ ] The page remains readable without mutation controls when CRM is `read_only` or deprecated, while denied module states never load CRM private code.
- [ ] Czech and English copy, page title, metadata, field labels, accessibility text, and retry text come from CRM i18n catalogs with no hardcoded user-facing strings.
- [ ] The page is keyboard operable, uses semantic heading/description-list/time markup, announces asynchronous states, and has no horizontal overflow at 375 px.
- [ ] CRM declares and correctly loads the repository-pinned UI-kit version when independently deployed; no Figma-derived token override, copied component CSS, or host-only styling dependency remains.
- [ ] Generator, CRM, Shell, BFF, browser, i18n, module-entrypoint, module-contract, typecheck, and repository gates pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the approved dynamic-page generator and its tests.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — prove dynamic generation, collisions, reruns, and atomic failure in disposable workspaces.
- `mise exec -- pnpm --filter @app/crm test:unit` — run CRM route/client/view-model and existing schema unit contracts.
- `mise exec -- pnpm --filter @app/crm test:component` — validate the Customer-detail query, UI-kit presentation, states, retry, localization, semantics, and accessibility.
- `mise exec -- pnpm --filter @app/crm test:integration` — retain governed Customer read, tenant isolation, and BFF behavior from the prerequisite feature.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run exact-page gate, dynamic parameter, approved remote, and Shell presentation tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — verify authenticated exact-page resolution remains typed and fail-closed.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e -- --grep "Customer detail|CRM"` — run localized authenticated/anonymous Customer-detail browser coverage, retries, and responsive checks.
- `mise exec -- pnpm i18n:boundaries` — validate complete locale ownership and prohibit hardcoded UI copy.
- `mise exec -- pnpm module-entrypoints:check` — verify the generated page stays behind the approved Shell/Core gateway.
- `mise exec -- pnpm check:module-contracts` — verify generated CRM manifest, registration, page contribution, and deployment contract consistency.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck the CRM page, Effect client integration, UI-kit usage, and generated route files.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- **Implementation dependencies:** complete `specs/chore-support-dynamic-microvertical-pages.md`, `specs/feature-crm-customer-contact-actions.md`, and `specs/feature-crm-customers-list-page.md` first. They respectively own the generated dynamic route-param boundary, `getCustomerDetail`, and the return route plus CRM UI/query dependencies and test infrastructure. All are currently planned local specs; the present CRM code exposes only readiness.
- No unresolved developer decision blocks the design. Implementation is blocked until the three prerequisite plans above are complete.
- **UI-kit integration risk:** CRM currently has no `@techsio/ui-kit` dependency and compiles CRM-authored Tailwind classes with the `crm:` prefix, while UI-kit `0.25.1` emits unprefixed utility classes. The implementation must prove an approved independently deployable consumer setup; Shell-global CSS alone is not sufficient proof.
- The UI-kit intent skills describe library version `0.3.2`, but this repository pins `0.25.1`. The actual installed `0.25.1` declarations were inspected and remain authoritative for component props.
- Figma source: file `ERP` (`GWzuNz24M0GzeOgGtuylj1`), page `Pre-Alpha Repo`, frame `Resource Detail — Běžný` (`6:780`, 1440×900). The local file is view-only. Connector-level layer inspection reached the Professional View-seat call limit after the frame was identified, so only the visible wireframe and named sibling states were used; no hidden component property was inferred.
- The wireframe's business copy belongs to a property-management example and is not CRM data. Customer presentation is limited to fields in the prerequisite Customer DTO.
- The back link targets the separately generated `/crm/customers` page and preserves the active locale; this feature does not duplicate list-page behavior.
