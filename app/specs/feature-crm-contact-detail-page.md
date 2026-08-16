---
type: feature
status: done
created: 2026-08-16
---

# Feature: CRM Contact detail page

## Feature Description

Add the generated CRM MicroVertical page `ContactDetail` at canonical route
`/crm/customers/:id/contacts/:contactId`, exposed by the locale-aware Shell as
`/cs/crm/customers/:id/contacts/:contactId` and `/en/crm/customers/:id/contacts/:contactId`.
The authenticated page presents one Contact within its parent Customer using the arrangement from
Figma file `ERP`, page `Pre-Alpha Repo`, frame `Resource Detail — Běžný` (`6:780`, 1440×900): a
compact return link, Contact heading, and responsive overview rows inside the existing Shell
dashboard layout.

The page must obtain Contact data by executing the existing CRM contract-derived `getContact`
Effect client operation through the CRM BFF. This is the implemented frontend/client spelling of
the requested `GetContactAction`; authoritative OntOS guidance models it as a governed Read because
it does not change state. The page must not generate a new Action, create a duplicate endpoint,
import a backend handler, read CRM persistence directly, or issue an ad hoc `fetch`.

Figma is a wireframe for component arrangement only. Use the installed `@techsio/ui-kit` components
and tokens without copying Figma colors, spacing, typography, borders, or component styling. Do not
add the wireframe's Documents, Timeline, or Audit tabs because this feature has no corresponding CRM
contracts.

## User Story

As a signed-in CRM user
I want to open a Contact within a Customer URL and see its current details
So that I can verify the Contact's identity, communication data, and lifecycle without leaving the
authenticated CRM workspace

## Problem Statement

CRM already persists Contacts and exposes an authenticated governed `getContact` BFF read, but it
has no Contact detail page or stable localized deep link. Users cannot inspect one Contact in the
context of its parent Customer, and the application has no page-level mapping for loading,
malformed IDs, parent/Contact mismatches, not-found, forbidden, authentication-expired, transport,
decode, unavailable, or internal failures.

## Solution Statement

Run the mandatory MicroVertical page generator with stable page identity `contact-detail` and the
canonical two-parameter URL. Adapt only the generated CRM page to validate both route parameters as
CRM UUIDs, call `getContact({ contactId })` through the generated CRM Effect BFF client, and retain
the operation's typed error union until route integration maps it to a closed presentation model.
Include both IDs in the query key and verify that a successful Contact response has
`customerId === routeParams.id`; render a safe not-found state instead of Contact data when the
hierarchical URL is inconsistent.

Follow the implemented Customer-detail page's page-local TanStack Query, Effect bridge, UI-kit,
localization, accessibility, and responsive patterns. Link back to the localized parent Customer
detail route. Render only fields present in the existing Contact DTO: Contact ID, Customer ID,
email, phone, lifecycle derived from `archivedAt`, created time, and updated time, with the Contact
name as the heading.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory MicroVertical page generator rule.
- `AGENTS.md` — authoritative MicroVertical, Effect, module-entrypoint, frontend, Figma, and toolchain constraints.
- `README.md` — generated dynamic-page, localized routing, private Shell gateway, and strict Effect BFF conventions.
- `package.json` — supported generator, focused tests, typecheck, i18n, contract, and final quality commands.
- `docs/architecture/MICROVERTICALS.md` — generated CRM BFF client seam and prohibition on frontend backend imports or ad hoc fetches.
- `docs/architecture/ERRORS.md` — typed BFF error contract and exhaustive frontend state mapping.
- `docs/architecture/DATA_ACCESS.md` — governed Contact read lifecycle, evidence, trusted context, and tenant isolation.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact page-gate ordering and bounded untrusted route-parameter boundary.
- `docs/architecture/MODULE_MANIFESTS.md` — generator order, dynamic route grammar, canonical URL, and locale ownership.
- `docs/architecture/ULTRAMODERN.md` — Effect-first behavior and prohibition on manually creating generated business artifacts.
- `docs/frontend/FRONTEND.md` — route-level data, view models, UI kit, i18n, accessibility, and responsive rules.
- `docs/frontend/FIGMA.md` — requires treating Figma only as an arrangement wireframe and retaining UI-kit visuals.
- `../docs/12_ROADMAP.md` — places Contacts/CRM basics in the current August delivery intent.
- `../docs/15_PRE_DEVELOPMENT_VALIDATION_REPORT.md` — records the older unresolved Party/Contact/CRM ownership question; app-local `crm.core` ownership is authoritative for this implementation.
- `specs/chore-support-dynamic-microvertical-pages.md` — completed prerequisite for generated multiple route parameters and post-gate remote props.
- `specs/feature-crm-customer-contact-actions.md` — completed owner of the `getContact` governed Read, Contact DTO, typed errors, BFF endpoint, client method, and Data Access evidence.
- `specs/feature-crm-customer-detail-page.md` — implemented page-local query, UI-kit detail presentation, Shell integration, localization, retry, and browser-test pattern to reuse.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory page generator supporting ordered unique named parameters.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-workspace coverage for exact two-parameter generation and generated Shell parameter selection.
- `verticals/crm/package.json` — existing UI-kit, TanStack Query, component-test, unit-test, integration-test, and typecheck dependencies/scripts.
- `verticals/crm/shared/apis/contact-detail.ts` — existing Contact DTO, UUID-backed request, typed Problem Details schemas, and `getContact` Effect API operation.
- `verticals/crm/src/api/crm-client.ts` — browser-safe contract-derived `getContact` method and Effect request runner.
- `verticals/crm/src/api/contact-detail.read.ts` — existing governed Contact-detail Read registration; remains private to the BFF and must not be imported by the page.
- `verticals/crm/api/contact-detail-read-server.ts` — existing authenticated BFF mapping; remains server-only and unchanged unless a proven contract defect is found.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx` — implemented Customer-detail query and presentation pattern plus the parent route used by the back link.
- `verticals/crm/tests/components/customer-detail-page.test.tsx` — focused component-test conventions for typed BFF calls, states, retry, localization, semantics, and source-boundary assertions.
- `verticals/crm/vertical.manifest.ts` — generated Contact-detail page component and canonical page-contribution slots.
- `verticals/crm/vertical.registration.ts` — generated owner-private lazy page registration.
- `verticals/crm/module-federation.config.ts` — generated `PageContactDetail` remote exposure and dependency sharing.
- `verticals/crm/src/i18n/resources.ts` — makes Czech and English Contact-detail copy available inside the federated boundary.
- `verticals/crm/locales/cs/crm.json` — Czech page, field, lifecycle, loading, failure, retry, and navigation copy.
- `verticals/crm/locales/en/crm.json` — English counterpart for every Contact-detail key.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated approved lazy page registry entry.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic exact-target loader that selects and bounds declared route parameters.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — Shell composition that passes route parameters only after all target gates and lazy loading succeed.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — two-parameter selection, target-identity separation, and denied pre-load behavior coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — approved remote prop and lazy-load ordering coverage.
- `verticals/crm/tests/support/e2e-customers.ts` — deterministic CRM browser fixture to extend with parent-linked Contact rows and cleanup ordering.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — existing localized authenticated/anonymous CRM browser flows to extend for Contact detail.
- `topology/ownership.json` — confirms CRM and Shell ownership and deployment boundaries.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.tsx` — generated Contact-detail page adapted to query the BFF and render the closed view model.
- `verticals/crm/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/route.meta.ts` — generated private, non-indexable CRM route metadata.
- `verticals/crm/src/federation/page-contact-detail.tsx` — generated federated CRM page boundary accepting only `id` and `contactId` route props.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.tsx` — generated Shell connector for the approved Contact-detail remote.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.data.ts` — generated Shell loader selecting only `id` and `contactId` after the exact-page gate.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/route.meta.ts` — generated localized private Shell route metadata.
- `verticals/crm/tests/components/contact-detail-page.test.tsx` — route decoding, hierarchical consistency, BFF query, presentation, localization, retry, accessibility, and source-boundary coverage.

## Implementation Plan

### Phase 1: Foundation

Generate the two-parameter private Contact-detail page and all Shell/manifest/registration/Module
Federation wiring through Codesmith. Verify the exact stable identities, route template, parameter
order, private metadata, and post-gate prop contract before adapting generated source.

### Phase 2: Core Implementation

Reuse the existing `getContact` Effect BFF client, validate both route UUIDs, create a hierarchical
query key, map the complete client failure union to closed view states, reject a response whose
Customer does not match the URL, and render the Contact DTO using existing UI-kit components and
semantic HTML. Add focused component tests beside each behavior.

### Phase 3: Integration

Verify that Shell authentication, legal-entity selection, module state, page permission, exact
target resolution, and approved remote loading all occur before CRM code or `getContact` executes.
Add Shell and browser coverage for both locales, exact ID propagation, wrong-parent suppression,
normal/loading/not-found/forbidden/unavailable behavior, retry, and mobile layout. Finish with all
focused commands and the complete repository quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the Contact-detail MicroVertical page

- [x] From `app/`, make the first implementation change by running `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page contact-detail --url /crm/customers/:id/contacts/:contactId`. Do not create the route, federated wrapper, manifest wiring, registration, Shell connector, locales, or Module Federation exposure by hand.
- [x] Inspect the generated output before adapting it: page entrypoint is `crm.core.page.contact-detail`; component key is `crm.core.page-contact-detail`; canonical route remains `/crm/customers/:id/contacts/:contactId`; owner and Shell filesystem paths use `[id]/contacts/[contactId]`; Czech and English URLs add only their locale prefix; the page is private/non-indexable and creates no navigation item; generated wrappers accept only `id` and `contactId`.
- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` with a focused disposable-workspace assertion for this two-parameter shape: ordered `routeParameterNames = ['id', 'contactId']`, exact owner/Shell directories and route metadata, bounded parameter selection, non-navigation generation, safe rerun, and no partial writes. Keep the existing general invalid/collision suite rather than duplicating it.

### 2. Reuse the existing Contact BFF contract without adding an Action

- [x] Verify the completed `specs/feature-crm-customer-contact-actions.md` contract remains present: browser-safe Contact DTO, `ContactDetailRequestSchema`, `getContact` HttpApi operation, governed `contactDetailRead`, authenticated BFF server, and exported `getContact` Effect client method.
- [x] Treat `getContact` as the required `GetContactAction` call at the page boundary, but do not generate or register a state-changing Action for this read. Add no duplicate endpoint, Schema, client wrapper, persistence service, database query, Action invocation, or page-owned evidence writer.
- [x] Keep page imports browser-safe: use only `verticals/crm/shared/**` DTO/schema types and `verticals/crm/src/api/crm-client.ts`; prohibit imports from `verticals/crm/api/**`, `verticals/crm/src/db/**`, `contact-detail.read.ts`, persistence services, or another deployment.

### 3. Validate the hierarchical route and load one Contact through the BFF

- [x] In the generated CRM page integration, decode both `routeParams.id` and `routeParams.contactId` with the existing CRM UUID schema and the same defensive maximum-length rule as Customer detail. Missing, malformed, undecodable, or overlong parameters map locally to `not_found` and must not invoke `getContact`.
- [x] Create a stable page-local TanStack Query client/provider and hierarchical query key containing both validated IDs, following the implemented Customer-detail pattern. At the query adapter edge, execute `getContact({ contactId })` through the generated CRM Effect client with locale, correlation ID, gateway options, and cancellation behavior already established by `crm-client.ts`; use no ad hoc `fetch`, Promise-only wrapper, global process cache, React effect, or backend import.
- [x] After a successful decode, require `contact.customerId === customerId` before creating the ready view model. A mismatch maps to the same safe `not_found` presentation as an absent Contact and must expose none of the returned Contact fields; the route Customer ID is untrusted navigation context, not authorization context.
- [x] Map the complete operation-specific error union exhaustively: ready; not-found for malformed IDs, `ContactDetailInvalidProblem`, `ContactDetailNotFoundProblem`, or parent mismatch; forbidden for definite BFF/gateway denial; authentication-expired for post-load session failure; and unavailable with backend/transport/decode/internal reason for retryable or sanitized failures. Shell-owned authentication, legal-entity, module-state, and exact-page failures must prevent the CRM remote and query from loading.
- [x] Add focused component tests in `verticals/crm/tests/components/contact-detail-page.test.tsx` for valid and invalid parameter pairs, the hierarchical query key, one exact `getContact({ contactId })` invocation, zero calls for local failures, parent mismatch suppression, exhaustive typed error classification, retry invocation, and absence of backend/database imports.
- [x] Rely on the existing governed Read runtime to commit one allowed Contact-detail Data Access Event before releasing each successful result. The page writes no Action Invocation, Audit Event, or Data Access Event itself.

### 4. Implement the Contact-detail presentation from the Figma arrangement

- [x] Adapt the generated page to render an existing UI-kit `Link` back to the localized parent Customer route `/crm/customers/:id`, preserving the active locale and using the validated Customer ID. Do not hardcode `/cs` or `/en`, and do not link malformed route input.
- [x] Render the Contact name as the page heading and a semantic `<dl>` overview with localized labels for Contact ID, Customer ID, email, phone, lifecycle status, created time, and updated time. Derive active/archived status only from `archivedAt`; render timestamps with `<time dateTime={...}>` and locale-aware formatting.
- [x] Use the installed UI-kit `Link` as a native anchor for usable `mailto:` and `tel:` values only after using the decoded Contact DTO values; keep the visible complete email/phone text and accessible link purpose. Long names, IDs, email addresses, phone values, and translated labels must wrap without page overflow.
- [x] Use Figma only for the back link → heading → overview ordering and compact key/value rhythm. Keep Shell chrome outside the remote, use UI-kit/default token visuals plus CRM-prefixed responsive layout utilities, and add no Figma-derived raw styles, property-management copy, inert tabs, edit/archive/restore controls, or new reusable component definition.
- [x] Keep the presentation portion free of BFF Effects, route hooks, raw DTO errors, and navigation commands. Keep query integration, pure data-to-view-model mapping, and presentation separated within the generated page module so no unsupported business file type is introduced.
- [x] Extend the component test alongside the presentation with English and Czech headings/labels, localized parent link, semantic description-list/time/link markup, lifecycle rendering, no tablist, keyboard-operable controls, long-value wrapping contract, and no hardcoded user-facing copy.

### 5. Implement explicit loading, failure, retry, and module-lifecycle behavior

- [x] Render a stable loading layout with UI-kit `Skeleton` parts matching the heading and detail rows, an accessible busy/status announcement, and no custom pulse elements or Figma styling.
- [x] Render localized UI-kit `StatusText` states for authentication-expired, forbidden, not-found, and unavailable outcomes. Authentication-expired and unavailable states expose a UI-kit `Button` retry; definite forbidden and not-found states do not imply retry grants access. Keep failure copy visible while retrying and restore focus to the results region when the attempt completes.
- [x] Treat empty, form validation, and conflict states as not applicable because a successful detail Read always returns one decoded Contact and this page performs no mutation. A Contact with empty persisted communication text still renders a stable labeled value without inventing business copy.
- [x] Keep the page readable without write affordances when CRM is `read_only` or `deprecated`. Inactive, suspended, quarantined, archived, missing, forbidden, or unavailable module/page targets remain Shell-owned states and must not load the Contact remote or call its BFF.
- [x] Extend component tests beside these behaviors for stable loading rows, `aria-live="polite"`, retry keyboard behavior/focus restoration, non-retryable forbidden/not-found states, archived Contact rendering, and no horizontal document overflow assumptions at 375 px.

### 6. Complete localization and generated metadata

- [x] Replace the generated starter copy in `verticals/crm/locales/cs/crm.json` and `verticals/crm/locales/en/crm.json` with matching Contact-detail keys for title/description, parent return link, every DTO field label, lifecycle values, loading, not-found, forbidden, authentication-expired, backend/transport/decode/internal failures, retry, retry-pending, and any accessible email/phone link labels. Hardcode no user-facing or accessibility text in TSX.
- [x] Keep both generated vertical and Shell route metadata private and non-indexable. Preserve canonical `/crm/customers/:id/contacts/:contactId`; let the router add the locale; do not add locale literals to metadata, manifest contribution, BFF route, request payload, or filesystem identity.
- [x] Add locale-key parity assertions in the Contact-detail component test and retain the repository i18n boundary check.

### 7. Integrate the generated Shell route and browser flow

- [x] Extend Shell loader/page unit tests to prove the generated connector selects only bounded `id` and `contactId`, keeps them separate from the resolved target, and passes both to the approved `crm.core.page-contact-detail` remote exactly once only after authentication, legal-entity selection, exact target resolution, module-state/permission success, and lazy loading. Anonymous, selection-required, forbidden, not-found, and unavailable Shell states must not consult/load the remote or call `getContact`.
- [x] Extend `verticals/crm/tests/support/e2e-customers.ts` with deterministic active and archived Contacts owned by the existing Customer fixtures. Seed Customers before Contacts, delete Contacts before Customers, and preserve tenant isolation and foreign-key cleanup.
- [x] Extend `apps/shell-super-app/tests/e2e/login.spec.ts` with localized Contact-detail flows: anonymous Czech/English direct URLs reveal no Contact and make no Contact BFF request; authenticated URLs render exact Contact data and parent link; the request reaches `/crm/contacts/detail` with only the URL `contactId`; malformed IDs and a Contact under the wrong route Customer show safe not-found output; declared 403/404 states do not retry; a 503 retries from the keyboard and restores focus; the 375 px page has no horizontal document overflow.
- [x] Keep the browser fixture and route interception at public generated seams. Do not import server handlers, persistence services, or private CRM registration into Shell tests.

### 8. Run all validation commands

- [x] Execute every command under `Validation Commands` from `app/` in order. Resolve every failure without weakening typed Effect errors, generated page ownership, the BFF seam, route-parameter validation, localization, accessibility, or unrelated tests.

## Testing Strategy

### Unit Tests

Use the scaffold generator's disposable workspace to prove exact two-parameter output and atomic
reruns. Use the new CRM component test to prove UUID decoding, hierarchical query identity, exact
`getContact` Effect-client invocation, parent consistency, closed error classification, ready and
loading models, lifecycle/timestamp formatting, localization parity, semantic markup, retry/focus,
and frontend import boundaries. Extend Shell unit tests for ordered parameter selection and the
post-gate approved-remote prop contract.

### Integration Tests

Retain the existing CRM BFF/integration suite as proof that `getContact` verifies its audience,
runs through the governed Read lifecycle, enforces tenant/module/access boundaries, returns only the
declared DTO/errors, and commits Data Access evidence before success. Extend Playwright coverage for
the complete Shell route → approved remote → generated Effect BFF → rendered Contact path in both
locales, including anonymous pre-gate behavior, exact payload, wrong-parent suppression, declared
failures, retry, and mobile layout.

### Edge Cases

- Either route parameter is absent, empty, malformed, overlong, or not a CRM UUID.
- Both UUIDs are valid but the returned Contact belongs to a different Customer.
- The Contact is archived while its parent Customer URL remains valid.
- The BFF returns declared invalid, unauthenticated, forbidden, not-found, unavailable, or internal Problem Details.
- The client encounters transport, empty-body, response-decode, gateway-audience, rate-limit, or schema failures.
- CRM is readable in `read_only`/`deprecated` state or denied/unavailable before the remote in other module states.
- Contact name, email, phone, IDs, and translated labels are long at a 375 px viewport.
- A retry is triggered from the keyboard while the previous failure remains visible.

## Acceptance Criteria

- [x] Codesmith generated `ContactDetail` with stable page name `contact-detail`, component key `crm.core.page-contact-detail`, and canonical `/crm/customers/:id/contacts/:contactId` without hand-authored page wiring.
- [x] The Shell exposes localized Czech and English Contact-detail URLs and passes only bounded `id` and `contactId` after every existing authenticated exact-page gate succeeds.
- [x] Valid route input invokes the contract-derived CRM `getContact` Effect client once with exactly `{ contactId }`; no ad hoc fetch, backend import, database access, duplicate endpoint, or state-changing Get Action exists.
- [x] Missing or invalid route IDs make no BFF call, and a successful Contact whose `customerId` differs from the route Customer renders no Contact data.
- [x] The ready page links back to the localized parent Customer and renders only the existing Contact DTO fields with semantic heading, description-list, time, email, and phone markup.
- [x] Loading, authentication-expired, forbidden, not-found, backend/transport/decode/internal unavailable, retrying, ready, active, and archived outcomes are explicit, localized, accessible, and exhaustively typed.
- [x] Figma `Pre-Alpha Repo` / `Resource Detail — Běžný` influences arrangement only; UI-kit visuals/tokens remain authoritative and no property example copy, inert tabs, or unsupported actions are added.
- [x] CRM `read_only` and `deprecated` states remain readable with no mutation controls, while denied/unavailable Shell states never load CRM private code or call `getContact`.
- [x] Czech and English copy and accessibility text come from CRM locale catalogs with matching key sets and no hardcoded user-facing strings.
- [x] The page is keyboard operable, retry restores focus, asynchronous feedback is announced, long values wrap, and the document has no horizontal overflow at 375 px.
- [x] Every successful `getContact` result still commits governed Read evidence before release, with no page-owned Action or evidence persistence.
- [x] Generator, CRM, Shell, BFF, browser, i18n, module-entrypoint, module-contract, typecheck, and repository gates pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the page generator and focused two-parameter generator test.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — prove exact two-parameter generation, safe rerun, collisions, and atomic failure in disposable workspaces.
- `mise exec -- pnpm --filter @app/crm test:unit` — retain Contact schemas, client exports, read registration, and CRM public-surface contracts.
- `mise exec -- pnpm --filter @app/crm test:component` — validate Contact-detail routing, BFF query, hierarchy check, presentation, states, localization, semantics, retry, and accessibility.
- `mise exec -- pnpm --filter @app/crm test:integration` — retain authenticated governed `getContact`, tenant isolation, typed BFF errors, and Data Access evidence.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate exact-page gates, ordered route parameters, approved remote loading, and pre-load denial behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e --grep "Contact detail|CRM"` — run localized anonymous/authenticated Contact-detail browser coverage, failures, retry, and responsive checks.
- `mise exec -- pnpm i18n:boundaries` — validate locale ownership, key usage, and absence of hardcoded UI copy.
- `mise exec -- pnpm module-entrypoints:check` — verify the generated Contact page remains behind the approved Shell/Core gateway.
- `mise exec -- pnpm check:module-contracts` — verify CRM manifest, registration, page contribution, and serialized deployment contract consistency.
- `mise exec -- pnpm typecheck` — typecheck the workspace graph, including CRM page, Effect client, UI-kit, generated routes, and Shell connectors.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- No unresolved decision blocks implementation.
- The completed CRM operation plan explicitly interprets `GetContactAction` as the `getContact` governed Read/client operation because reads must not create state-changing Actions. This spec preserves the user's required BFF call while following that authoritative architecture decision.
- Dynamic-page support, Customer/Contact operations, Customer detail, CRM UI-kit/TanStack dependencies, and Shell browser infrastructure are already implemented prerequisites.
- The route Customer ID scopes navigation and detects inconsistent hierarchical URLs; the existing authenticated BFF authorization remains tenant-level and receives only `contactId`. The page's equality check is presentation consistency, not an authorization substitute.
- Figma source: file `ERP` (`GWzuNz24M0GzeOgGtuylj1`), page `Pre-Alpha Repo`, frame `Resource Detail — Běžný` (`6:780`, 1440×900). The local file is view-only. Connector-level inspection hit the Professional View-seat call limit, so the visible selected wireframe and named sibling states were used and no hidden component properties were inferred.
- The Figma frame's property-management labels/data are example content only. The Contact page is limited to the existing CRM Contact DTO.
- Repository-level product documentation still records Party/Contact/CRM ownership as unresolved, while the app-local manifest and implemented contracts assign this slice to `crm.core`. Per `AGENTS.md`, app-local architecture is authoritative; product documentation reconciliation is outside this feature.
- The unrelated untracked `specs/feature-crm-contact-create-page.md` and `specs/feature-crm-customer-create-page.md` are user-owned and must remain untouched during implementation.

## Implementation Evidence

### Summary

- Generated and implemented the private localized CRM Contact-detail page, its Shell/manifest/registration/Module Federation wiring, closed typed view states, localized responsive UI-kit presentation, and deterministic Contact browser fixtures.
- Added generator, CRM component, Shell unit, and Playwright coverage for the two-parameter route, exact BFF payload, hierarchy mismatch, error families, retry/focus, localization, semantics, and 375 px overflow behavior.

### Changed Files

- Aggregate tracked diff plus intended untracked files: 24 files changed, 1,844 insertions, 31 deletions, across the CRM page/locales, generated CRM/Shell wiring, generator tests, CRM component/fixture tests, Shell unit tests, browser tests, and this specification.

### Tests Written or Updated

- `scripts/scaffolding/tests/scaffold-generators.test.mts` — proves exact ordered two-parameter output, safe rerun, non-navigation behavior, and atomic failure.
- `verticals/crm/tests/components/contact-detail-page.test.tsx` — proves route decoding, hierarchical query/call behavior, mismatch suppression, exhaustive typed failures, localized semantic presentation, lifecycle, loading, retry/focus, wrapping, and browser-safe imports.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` and `page.test.tsx` — prove bounded parameter selection and post-gate approved-remote props.
- `verticals/crm/tests/support/e2e-customers.ts`, `apps/shell-super-app/tests/e2e/auth-fixture.ts`, and `login.spec.ts` — prove deterministic parent-linked Contacts and anonymous/authenticated localized browser flows, exact payloads, safe failures, retry/focus, and mobile overflow behavior.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — passed, 36 tests.
- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 20 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 81 tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 3 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 156 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e --grep "Contact detail|CRM"` — passed, 6 tests.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm typecheck` — passed.
- `mise exec -- pnpm check` — passed, including format, lint, Action tests, typecheck, architecture contracts, and performance readiness.
- `mise exec -- pnpm exec biome check specs/feature-crm-contact-detail-page.md` — failed because this workspace does not install Biome; no source check ran.
- `mise exec -- pnpm exec oxfmt --check specs/feature-crm-contact-detail-page.md` — passed using the repository's configured formatter.
- `mise exec -- pnpm format:check` — passed after the final evidence update, 420 files checked.
- `mise exec -- pnpm build` — compiled CRM successfully, then the release-envelope guard rejected the expected dirty-worktree `sourceRevision "workspace"`.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/.codex/worktrees/crm11/ontos ULTRAMODERN_SOURCE_REVISION=0000000000000000000000000000000000000001 mise exec -- pnpm build` — passed the complete CRM, Shell, Module Federation type, and performance build.

### Review

- Re-read and reviewed the final implementation against `../AGENTS.md`, `AGENTS.md`, MicroVertical, Action, Effect error, database/data-access, outbox, module-entrypoint, module-manifest, UltraModern, frontend, Figma, roadmap, and pre-development guidance. The authoritative app-local `crm.core` ownership was applied over older unresolved product context.
- The UI-kit adoption audit found no native interactive replacement, custom loading primitive, unsupported prop, redundant component appearance override, plain CSS, or missing token entrypoint. The page uses UI-kit `Link`, `Skeleton`, `StatusText`, and `Button` with page-level semantic/layout utilities only.
- Review fixes included robust long-value wrapping in the federated runtime and lint/format corrections. Final source-boundary checks and `git diff --check` pass.
- Browser review screenshot: `.codex/reports/review/feature-crm-contact-detail-page/contact-detail-cs-mobile.png`.

### Deviations and Follow-ups

- The release-envelope plugin intentionally rejects a build from a dirty uncommitted worktree when it resolves the revision as `workspace`; the full build passes with an explicit immutable test revision. No product or architecture follow-up remains.
