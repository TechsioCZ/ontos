---
type: feature
status: done
created: 2026-08-14
---

# Feature: CRM Customers List Page

## Feature Description

Add a generated CRM MicroVertical page named `CustomersListPage` at the canonical path
`/crm/customers`, exposed by the localized Shell as `/cs/crm/customers` and
`/en/crm/customers`. The page gives an authenticated, permitted CRM user a compact overview of
Customers using the installed `@techsio/ui-kit@0.25.1` semantic Table and supporting UI-kit
components.

Use Figma file `ERP`, page `Pre-Alpha Repo`, frame `Audit Log — Naplněný` (`6:1042`) only as a
wireframe for the content arrangement: page heading, compact filter controls, tabular results, and
pagination controls. The authenticated Shell already owns the sidebar, tenant/legal-entity
selectors, global search, header, and account menu, so the CRM remote must render only the page
content and must not duplicate that chrome or copy Figma colors and fixed measurements.

The populated list is loaded through the CRM MicroVertical's generated Effect BFF client. The
requested `GetCustomersAction` terminology maps to the architecture-compliant governed Customer
list read exposed as `getCustomerList`; it is not implemented as a state-changing OntOS Action.

## User Story

As an authenticated CRM user
I want to view and page through Customers in a clear table
So that I can quickly understand which Customer records exist and whether they are active or
archived

## Problem Statement

CRM has persistence for Customers but no dedicated Customers page. The generated `/crm` starter
shows only a placeholder heading, and the current CRM package does not declare or load the UI kit.
The Customer list read and typed BFF client are now implemented, but frontend code still needs an
approved generated page, typed client integration, explicit user-facing states, localized copy,
and semantic table presentation. Direct database access, a backend implementation import, an ad
hoc `fetch`, or a getter modeled as an Action would violate the MicroVertical and governed-read
boundaries.

## Solution Statement

Run the mandatory MicroVertical page generator with stable identity `customers-list` and canonical
URL `/crm/customers`, producing `CustomersListPage` and all CRM/Shell manifest, registration,
Module Federation, route, and locale wiring before adapting the generated page. Add the pinned UI
kit to CRM and load its package token/theme output while preserving CRM-prefixed Tailwind layout
utilities. Reuse `Table`, `Select`, `Badge`, `Skeleton`, `StatusText`, `Button`, and `LinkButton`
from their public package subpaths; do not recreate or restyle their primitives.

Keep query integration and pure presentation separate inside the generated page module so no
unsupported business file type is hand-authored. Because a Shell-composed federated page loads
after the Shell route loader and the repository forbids ordinary data fetching in a React effect,
use a page-local TanStack Query provider/hook as the framework edge. Its query function bridges the
typed `getCustomerList` Effect to the Promise required by the query library while retaining the
operation-specific error union for exhaustive UI mapping.

Treat `status=active|archived|all` and a non-negative `offset` as shareable URL state, with active
and zero as safe defaults, and request a fixed page size of 25. Render name, Customer ID, lifecycle
status, creation time, and update time in a semantic UI-kit Table. Use previous/next URL navigation
derived from `offset` and the BFF's nullable `nextOffset`; do not fabricate a total count for the
UI-kit Pagination component. Present loading, populated, empty, forbidden, and unavailable/retry
states explicitly and localize all visible and accessibility copy in English and Czech.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory Codesmith page generator rule.
- `AGENTS.md` — authoritative MicroVertical, BFF, Effect, module-entrypoint, UI, i18n, and toolchain constraints.
- `README.md` — generated page identity/URL behavior and localized Shell route convention.
- `docs/architecture/MICROVERTICALS.md` — strict CRM deployment seam and virtual generated BFF boundary.
- `docs/architecture/ERRORS.md` — typed BFF client error preservation and exhaustive frontend mapping.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — authenticated Shell page resolution before private remote loading.
- `docs/architecture/ULTRAMODERN.md` — Effect-first and Codesmith business-artifact rules.
- `docs/frontend/FRONTEND.md` — route/feature/presentation separation, query selection, explicit UI states, UI-kit use, localization, accessibility, and responsive behavior.
- `docs/frontend/FIGMA.md` — treats Figma as arrangement-only and requires UI-kit visuals.
- `specs/feature-crm-customer-contact-actions.md` — completed implementation plan for the governed `customer-list` read, its `getCustomerList` Effect client method, typed Customer DTO, bounded offset result, assertion gateway, and BFF error union.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory generator that creates the page, route metadata, locales, manifests, registrations, federation exposure, Shell connector, and approved lazy client.
- `verticals/crm/package.json` — CRM runtime/UI and component-test dependencies and scripts.
- `pnpm-lock.yaml` — pinned dependency graph after adding CRM-owned UI-kit, query, and test dependencies.
- `verticals/crm/src/routes/index.css` — CRM-prefixed Tailwind source used by the federated page without exporting unprefixed utilities into the Shell.
- `verticals/crm/src/api/crm-client.ts` — generated/contract-derived frontend BFF facade that must supply `getCustomerList`; the page must not bypass it.
- `verticals/crm/shared/apis/customer-list.ts` — implemented browser-safe request, Customer result, pagination, and typed Problem Details contract.
- `verticals/crm/shared/api.ts` — composed CRM strict Effect API contract and API prefix.
- `verticals/crm/vertical.manifest.ts` — generator-owned `crm.core.page.customers-list` component/page descriptors while the module retains its single existing CRM navigation entry.
- `verticals/crm/vertical.registration.ts` — generator-owned private page loader registration.
- `verticals/crm/module-federation.config.ts` — generator-owned `./PageCustomersList` remote exposure.
- `verticals/crm/locales/cs/crm.json` — Czech page, table, filter, state, retry, date, and pagination copy.
- `verticals/crm/locales/en/crm.json` — matching English copy.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated Shell allowlist entry for the exact Customers page component.
- `apps/shell-super-app/src/routes/shell-frame.tsx` — existing authenticated chrome that wraps the remote and must not be duplicated by CRM.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — authenticated/anonymous localized route, BFF-backed results, retry, and narrow-viewport browser coverage.
- `package.json` — supported workspace validation, i18n, API, entrypoint, contract, and build commands.

### New Files

- `verticals/crm/src/routes/[lang]/crm/customers/page.tsx` — generated `CustomersListPage`, then adapted with query integration, typed view-model mapping, and pure UI-kit presentation.
- `verticals/crm/src/routes/[lang]/crm/customers/route.meta.ts` — generated private, non-indexable `/crm/customers` route metadata and read entrypoint.
- `verticals/crm/src/federation/page-customers-list.tsx` — generated localized Module Federation wrapper for the page.
- `verticals/crm/src/federation/page-customers-list.runtime.js` / `.d.ts` — runtime-only route bridge that preserves the generated `src`-only Module Federation declaration boundary while keeping the governed CRM client in the browser bundle.
- `verticals/crm/src/routes/ui-kit.css` — standalone, unprefixed UI-kit token/theme/class compilation context loaded by the CRM route layout and omitted from federated expose assets.
- `verticals/crm/shared/cors.ts` — owner-local shared CORS policy used by the CRM BFF and deployment adapter.
- `verticals/crm/tests/support/e2e-customers.ts` — CRM-owned browser fixture for Customer test data.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/page.tsx` — generated Shell page connector.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/page.data.ts` — generated exact-page Shell gateway loader.
- `apps/shell-super-app/src/routes/[lang]/crm/customers/route.meta.ts` — generated private Shell route metadata.
- `verticals/crm/modern.rstest.config.ts` — CRM Modern.js adapter configuration for component tests.
- `verticals/crm/rstest.config.ts` — CRM happy-dom component-test configuration using the repository's existing RSTest pattern.
- `verticals/crm/tests/components/customers-list-page.test.tsx` — page query/presentation tests for every visible state and interaction.

## Implementation Plan

### Phase 1: Foundation

Generate the exact CRM page and Shell connector first. Then make CRM an independent consumer of the
pinned UI kit, add the client-query runtime needed by a federated list with retry/pagination, and
add focused component-test infrastructure using the same versions and configuration style already
used by the Shell. Preserve generated owner slots and CRM's `crm:` Tailwind namespace.

### Phase 2: Core Implementation

Adapt only the generated page module for business UI. Parse bounded URL query state, call the
generated `getCustomerList` Effect through the BFF facade, exhaustively convert its success/error
channels into a closed presentation model, and render the Figma-inspired arrangement from UI-kit
components. Add tests beside the behavior for loading, populated, active/archived status, empty,
forbidden, unavailable/retry, invalid URL values, pagination, table semantics, and keyboard use.

### Phase 3: Integration

Complete English/Czech catalogs and metadata, prove the authenticated Shell resolves and lazily
loads the exact page at both localized URLs, and verify the browser issues the Customer list
operation through the CRM BFF before rendering rows. Test anonymous guarding, retry, mobile layout,
and the independently deployable CRM build, then run all repository boundaries and the final gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the Customers list page and owner wiring

- [x] From `app/`, run `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customers-list --url /crm/customers` before creating or editing any page artifact.
- [x] Inspect the generated mutations and retain the stable `CustomersListPage` / `page-customers-list` / `crm.core.page.customers-list` identities, canonical `/crm/customers` route, Czech/English localized paths, private non-indexable metadata, exact Shell gateway loader, owner manifest/registration slots, `./PageCustomersList` exposure, and approved Shell lazy-client entry. Do not hand-edit generated wiring into a different identity.

### 2. Establish CRM UI-kit, query, and component-test infrastructure

- [x] Run `mise exec -- pnpm --filter @app/crm add @techsio/ui-kit@0.25.1 @tanstack/react-query@5.101.4` so CRM directly owns its UI and query runtime; keep the resulting `verticals/crm/package.json` and `pnpm-lock.yaml` changes scoped to CRM.
- [x] Run `mise exec -- pnpm --filter @app/crm add --save-dev @modern-js/adapter-rstest@npm:@bleedingdev/modern-js-adapter-rstest@3.5.0-ultramodern.96 @rstest/core@0.11.4 @testing-library/dom@10.4.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 happy-dom@20.8.3`, create `modern.rstest.config.ts` / `rstest.config.ts`, and add a `test:component` script without replacing the existing Node unit/integration scripts.
- [x] Add a dedicated standalone stylesheet that loads UI-kit tokens, theme, and published `dist` class sources while retaining `verticals/crm/src/routes/index.css` as the existing `crm:`-prefixed federation-safe Tailwind source. Do not copy Figma values, add plain CSS, or add app/component token overrides unless a failing standalone render proves a real token gap.
- [x] Add a focused CSS/build assertion or component test proving UI-kit Table classes/tokens are available when CRM runs independently, not only because the Shell happened to load the same package.

### 3. Integrate the governed Customer list read through the BFF

- [x] Reuse the implemented `getCustomerList` Effect from `verticals/crm/src/api/crm-client.ts` and its generated assertion gateway/BFF endpoint. Verify the current request, response, and typed error contract before wiring the page; do not recreate the read, contract, identity boundary, or backend service in this feature.
- [x] In the generated `page.tsx`, keep one pure presentation contract separate from the query integration within the same generated module. Do not add an ungenerated business component, hook, view-model, or repository file.
- [x] Parse `status` as exactly `active | archived | all` and `offset` as a bounded non-negative integer from the current localized route. Map absent or invalid values to `active` and `0`, use `limit: 25`, and ensure only this validated business payload enters `getCustomerList`.
- [x] Create a stable page-local Query client/provider and query key containing the validated status, offset, and limit. At the query-library adapter edge, execute `getCustomerList` through the existing Effect runner; retain its declared backend, transport, and decode error union as the query error type and do not use `fetch`, import a backend/read implementation, or weaken the error to a string.
- [x] Exhaustively map successful items/`nextOffset`, definite forbidden errors, authentication expiry, retryable BFF unavailability, transport failure, decode failure, and unexpected sanitized internal responses to a closed presentation model. Authentication expiry, transport/decode, `503`, and sanitized `500` states offer a safe retry; definite `403` does not imply that retry will grant access.
- [x] Add component tests that mock only the generated frontend client seam and prove the initial and URL-derived requests invoke `getCustomerList` once with the exact bounded payload through the BFF facade, never a raw request or persistence import.

### 4. Build the Figma-arranged Customers presentation with the UI kit

- [x] Replace the generated placeholder with a content section headed by localized `Customers` / `Zákazníci`; rely on the surrounding `AuthenticatedDashboardLayout` for sidebar and header chrome and keep `UltramodernRouteHead` intact.
- [x] Render the archive filter with the supported UI-kit `Select` compound anatomy and array value. Changing it updates the localized route query, resets `offset` to zero, remains keyboard-operable, and refetches through the query key; all label, option, placeholder, and accessibility text comes from CRM i18n.
- [x] Render populated results with `@techsio/ui-kit/organisms/table` using `Table.Caption`, `Header`, `Body`, `Row`, `ColumnHeader`, and `Cell`; use supported `variant="line"` and `size="sm"` props and no div grid, native table, inline row/cell appearance classes, or Figma-derived component styling.
- [x] Show localized columns for Customer name, Customer ID, status, created time, and updated time. Format ISO timestamps with the active locale, render active/archive lifecycle as short semantic UI-kit `Badge` labels, and keep rows non-interactive until an approved Customer detail page exists.
- [x] Wrap the table in a responsive overflow container, keep the page width fluid inside the Shell main region, preserve a visible caption/heading relationship for assistive technology, and ensure the document itself has no horizontal overflow at 375px.
- [x] For loading, preserve the final table shape with UI-kit `Skeleton` parts and an accessible polite status. For an empty successful result, render one localized empty-state message without a table body or pager. For forbidden and unavailable states, use UI-kit `StatusText`; use a UI-kit `Button` for in-place retry and restore focus/announcement behavior after retry.
- [x] Derive previous offset as `max(0, offset - 25)` and next navigation from the response's nullable `nextOffset`. Use UI-kit `LinkButton` with the Modern localized Link adapter so status and unrelated safe query parameters are retained. Disable/omit unavailable directions honestly; do not invent a total count or numbered pages for UI-kit `Pagination` because the governed BFF intentionally returns `nextOffset`, not `count`.
- [x] Extend component tests for semantic caption/headers/cells, row order, exact Customer values, locale-aware dates, active/archived badges, loading skeleton geometry, empty state, forbidden state without retry, unavailable state with one retry, filter keyboard behavior, URL pagination, and narrow-container overflow behavior.

### 5. Localize the page and preserve private route metadata

- [x] Replace the generator starter copy under `crm.pages.customersList` in both `locales/en/crm.json` and `locales/cs/crm.json` with aligned title/description, filter, table header/caption, status, loading, empty, forbidden, unavailable, retry, and previous/next keys. Do not hardcode visible or `aria-*` strings in TSX.
- [x] Keep `route.meta.ts` canonical path `/crm/customers`, `public: false`, `indexable: false`, owner `crm`, module `crm.core`, and entrypoint `crm.core.page.customers-list`; update only its generated title/description keys through the locale values rather than adding public discovery output.
- [x] Add locale parity assertions to the component suite and verify Czech and English headings, filter labels, statuses, dates, errors, retry text, and navigation text all render from the owning CRM namespace.

### 6. Prove Shell, Module Federation, and browser integration

- [x] Extend existing Shell unit coverage only where the new generated exact-page registry/loader output changes snapshots or allowlists. Prove `/crm/customers` resolves `crm.core.page.customers-list`, rejects anonymous/forbidden/unavailable states before the remote loader runs, and invokes the approved `PageCustomersList` loader only after successful resolution.
- [x] Extend `apps/shell-super-app/tests/e2e/login.spec.ts` with an authenticated Customer-list flow in Czech and English. Prove anonymous direct visits reveal no Customer content; an authenticated permitted visit keeps one Shell sidebar/header, loads the exact remote, calls the CRM Customer-list BFF operation, and renders the returned table rows.
- [x] Add browser coverage for an empty response, one retryable BFF failure followed by successful retry, status/offset navigation, keyboard access to filter and retry controls, and a 375px viewport with table-local horizontal overflow but no body overflow.
- [x] Keep operation-level BFF status/error decoding, assertion verification, tenant isolation, and governed evidence coverage in the existing CRM integration suite; do not duplicate backend fixtures or bypass the generated client in page tests.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` in order and resolve all feature-related failures without adding a getter Action, a raw fetch, duplicated Shell chrome, custom table primitive, hardcoded user-facing text, ungenerated business file type, or unrelated Customer capability.

## Testing Strategy

### Unit Tests

Retain the existing Node unit tests for the `getCustomerList` schemas and typed client. Add CRM
RSTest/happy-dom component coverage around the generated page module with the generated BFF client
mocked at its public Effect seam. Test URL parsing, query keys and exact payloads, exhaustive error
mapping, retry behavior, view-model formatting, UI-kit Table semantics, filters, lifecycle badges,
localized copy, focus, and responsive overflow. Test presentation from plain props/query outcomes;
do not mock or import backend services.

### Integration Tests

Use the existing CRM in-process BFF integration tests to prove the actual governed Customer
list read, assertion, typed errors, tenant isolation, evidence, and client decoding. Use Shell unit
tests for exact entrypoint resolution and lazy loading, then Playwright for the complete localized
Shell → Module Federation page → generated CRM BFF client flow. Browser tests may control BFF
outcomes at the network seam for deterministic empty/error/retry presentation, while at least one
populated path must exercise the real generated endpoint/client contract.

### Edge Cases

- The URL has an absent, unknown, repeated, negative, fractional, or excessively large `offset` or an unknown `status` value.
- The first page has no previous offset; the last page has `nextOffset: null`; a middle page has both directions.
- The BFF returns zero Customers, fewer than 25, or 25 plus a next offset.
- Customer names are long, Customer IDs do not wrap the whole document, and translated headers remain usable at 375px.
- `archivedAt` is null for an active row and an ISO timestamp for an archived row.
- The BFF returns definite `403`, expired `401`, retryable `503`, sanitized `500`, transport failure, or decode failure.
- Retry is activated repeatedly or by keyboard; only the query operation reruns and focus/status feedback remains accessible.
- Module state or Shell permission prevents the private remote from loading, independently of a later BFF read failure.
- Validation and conflict UI are not applicable because this page performs no mutation and constructs its bounded list input from validated URL state.

## Acceptance Criteria

- [x] `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customers-list --url /crm/customers` is the first implementation action and all generated owner/Shell wiring retains the `customers-list` identity.
- [x] An authenticated, selected, permitted user can open `/cs/crm/customers` and `/en/crm/customers`; an anonymous, forbidden, disabled, or unavailable module state does not load or reveal the private CRM page.
- [x] The CRM remote renders only Customers content inside the existing authenticated Shell chrome and does not recreate the Figma sidebar, selectors, header, global search, account menu, colors, or fixed dimensions.
- [x] The page calls the architecture-compliant `getCustomerList` governed read (the requested `GetCustomersAction` intent) through the generated CRM Effect BFF client and never uses raw fetch, database access, or a backend import.
- [x] The installed `@techsio/ui-kit@0.25.1` Table compound component renders the Customer name, Customer ID, status, created time, and updated time with semantic caption/header/body markup.
- [x] Active/archive filtering and previous/next offsets are validated, shareable in the localized URL, preserve safe state, and trigger exactly one matching BFF query.
- [x] Loading, populated, empty, forbidden, authentication-expired, unavailable, transport/decode, and retry states are explicit, localized, accessible, and covered by tests; no mutation/conflict state is invented.
- [x] Previous/next navigation is honest for the `nextOffset` contract and no total count or numbered UI-kit Pagination state is fabricated.
- [x] All visible copy, accessible names, date formatting, statuses, errors, and navigation text work in English and Czech from CRM-owned locale catalogs.
- [x] The page and table remain usable by keyboard and at 375px, with any horizontal overflow confined to the table container.
- [x] CRM declares and loads its own UI-kit/query dependencies and styles so the independently built/deployed remote does not depend on Shell CSS side effects.
- [x] Focused component, Shell, BFF integration, browser, type, build, i18n, API, entrypoint, contract, and repository gates pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm scaffold:microvertical-page -- --help` — confirm the mandatory page generator and custom canonical URL option remain available without writing.
- `mise exec -- pnpm --filter @app/crm test:unit` — validate the existing CRM schemas, client contracts, locale contracts, and source boundaries.
- `mise exec -- pnpm --filter @app/crm test:component` — validate the Customers page query integration, UI-kit semantics, states, interactions, localization, and accessibility.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate the real governed Customer-list BFF operation and generated client seam used by the page.
- `mise exec -- pnpm typecheck` — validate workspace project references, including the CRM page, query, UI-kit, generated client, and typed error composition.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate exact-page resolution, generated lazy registry, Shell guarding, and remote loading.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e -- --grep "customers"` — validate authenticated/anonymous localized browser behavior, real BFF-backed rows, retry, keyboard, and responsive layout.
- `mise exec -- pnpm i18n:boundaries` — enforce CRM-owned English/Czech copy and no cross-owner locale leakage.
- `mise exec -- pnpm api:check` — ensure the page uses the strict Effect client/BFF topology rather than an ad hoc request.
- `mise exec -- pnpm module-entrypoints:check` — validate the generated page descriptor, Shell gateway, private registration, and approved lazy load.
- `mise exec -- pnpm check:module-contracts` — validate the CRM manifest/registration and serialized page contract.
- `mise exec -- pnpm --filter @app/crm build` — compile the independently deployable CRM page, UI-kit CSS, Module Federation exposure, and BFF client.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Generated the private `customers-list` CRM page and retained its exact owner/Shell descriptors, localized routes, registration, and `PageCustomersList` federation exposure.
- Implemented the typed TanStack Query integration over the existing `getCustomerList` Effect BFF client and a pure UI-kit presentation for validated URL filters, offset navigation, explicit states, retry/focus behavior, localization, and responsive table overflow.
- Added CRM-owned UI-kit/query/test dependencies, independent UI-kit CSS compilation, cross-origin CRM BFF support, Shell integration, deterministic CRM browser fixtures, and a federation runtime/declaration bridge that keeps the generated DTS boundary valid.
- Kept the Shell layout untouched and filtered the CRM standalone `async-index` stylesheet from Module Federation expose assets; exposed pages load only CRM-prefixed CSS, while standalone CRM still loads its complete UI-kit class source.
- Kept one existing CRM module link in the sidebar instead of publishing a second identical link for the Customers subpage.

### Changed Files

- New files include the generated page/Shell artifacts, CRM component-test configuration and suite, UI-kit CSS entry, owner-local CORS/test support, and the federation runtime/declaration bridge.

### Tests Written or Updated

- `verticals/crm/tests/components/customers-list-page.test.tsx` — 17 tests for URL validation, exact BFF payload/query key, semantic UI-kit table output, localized dates/copy, exhaustive backend/transport/decode presentation states, retry/focus, keyboard filtering, pagination, token ownership, and local overflow.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` and `page.test.tsx` — exact governed page resolution, guarding, and approved lazy remote loading.
- `apps/shell-super-app/tests/e2e/login.spec.ts` / `auth-fixture.ts` — real English/Czech CRM BFF data, anonymous privacy, empty and retry states, keyboard interaction, URL filtering/paging, single Shell chrome, and 375px overflow behavior.
- The populated browser path now measures the desktop geometry and fails unless the sidebar ends before the main content begins, preventing a present-but-top-stacked menu regression.

### Validation

- `mise exec -- pnpm scaffold:microvertical-page -- --help` — passed; required `--vertical`, `--page`, and optional canonical `--url` remain available.
- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 20 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 17 tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 3 governed BFF/database integration tests.
- `mise exec -- pnpm typecheck` — passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 146 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — passed, complete 16-test Chromium suite.
- `ULTRAMODERN_REVIEW_SCREENSHOT_PATH=<review-path> mise exec -- pnpm --dir apps/shell-super-app exec playwright test -g "customers stay private anonymously"` — passed with the sidebar geometry, single CRM-link assertion, and corrected desktop screenshot.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `GIT_CEILING_DIRECTORIES=<worktree> ULTRAMODERN_SOURCE_REVISION=0000000000000000000000000000000000000001 mise exec -- pnpm --filter @app/crm build` — passed, including federated types, CRM client/server bundles, module/public-surface artifacts, and Node deploy output.
- `mise exec -- pnpm check` — passed, including formatting, lint, Action unit tests, type checking, skill/i18n/API/database/entrypoint/module/scaffold contracts, and performance readiness.
- The corresponding CRM and Shell production builds passed with the same explicit immutable test source revision.

### Review

- Re-read and reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, the MicroVertical, Action, Effect error, database/data-access, outbox, entrypoint, manifest, UltraModern, frontend, and Figma guidance, plus the relevant repository product/architecture context. App-local independently deployable MicroVertical guidance was applied where older repository context differs.
- Fixed review findings involving federation CSS leakage, duplicate sidebar entries, exhaustive typed-error mapping, a Shell-owned CRM database fixture, duplicated CORS policy, unrelated authentication semantics, lint/accessibility issues, and generated diagnostic artifacts. Final `git diff --check` and all repository gates pass.
- Browser review evidence: `.codex/reports/review/feature-crm-customers-list-page/customers-en-layout-fixed.png` and `.codex/reports/review/feature-crm-customers-list-page/customers-mobile-pagination.png`; the desktop sidebar remains left of the main region and the 375px table overflow remains local to the table container.

### Deviations and Follow-ups

- The release-envelope plugin intentionally rejects the literal dirty-worktree build command with `sourceRevision "workspace"`; commits are prohibited by the implementation skill unless explicitly requested. The same CRM and full workspace builds passed with the current immutable source revision supplied explicitly, and the plan-prescribed exact command's only failure was that release metadata guard after compilation.
- No product or architecture follow-up remains.

## Notes

- Figma was inspected in the local app at file `ERP`, page `Pre-Alpha Repo` (not `Pre-Alpha`), frame `Audit Log — Naplněný`, node `6:1042`, size 1440×900. Repository guidance makes it an arrangement wireframe only; installed UI-kit props/tokens are authoritative for appearance.
- The UI-kit skill metadata describes an older library version, while the checked-in lockfile and published declarations show `@techsio/ui-kit@0.25.1`. The installed `0.25.1` declarations were inspected directly and confirm the planned Table, Select, Badge, Skeleton, StatusText, Button, and LinkButton APIs.
- `specs/feature-crm-customer-contact-actions.md` has been implemented and is tracked on `develop`; the Customer-list BFF operation, typed client, and supporting tests now exist and must be reused by this page.
- `GetCustomersAction` is interpreted as the requested frontend operation intent. OntOS reserves Actions for state changes, so the page calls the implemented governed read method `getCustomerList` through the BFF. This is an architecture mapping, not an unresolved developer decision.
- A client query library is deliberate because the Shell-composed remote is loaded after the Shell route loader, Customer pagination/retry needs caching/refetching, and `docs/frontend/FRONTEND.md` forbids ordinary route fetching in a React effect. The provider and integration remain inside the generated page module to avoid introducing an ungenerated business file type.
- The implemented list contract intentionally returns `items` plus nullable `nextOffset` and avoids an unbounded total-count query. Therefore this increment uses honest previous/next navigation rather than the UI-kit Pagination component, whose required `count` cannot be supplied truthfully.
- No new Customer fields, detail route, create/edit/archive controls, Policy, Action, Domain Event, Outbox Message, or shared UI component is in scope.
- The focused `pnpm --filter @app/crm typecheck` command is intentionally not a validation gate because the current standalone package invocation fails on pre-existing Core declaration/checker ordering. The authoritative root `pnpm typecheck` includes CRM through workspace project references and passes on `develop`.
- No unresolved developer decision or dependency blocks implementation.
