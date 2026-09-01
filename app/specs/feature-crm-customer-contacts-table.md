---
type: feature
status: done
created: 2026-08-16
---

# Feature: CRM Customer contacts table

## Feature Description

Add a Contacts section to the existing CRM Customer detail at `/cs/crm/customers/:id` and its other localized variants. The section is an internal component of `CustomerDetailPage`, not a new page or Shell entrypoint. It presents the active Contacts belonging to the current Customer in the installed `@techsio/ui-kit` Table and loads them through the CRM generated Effect BFF client operation `getContactList`.

The layout follows the `Pre-Alpha Repo` / `Audit Log — Naplněný` Figma wireframe only for arrangement: a section heading above a full-width, line-separated table. Visual styling remains owned by `@techsio/ui-kit` and the CRM Tailwind/token setup.

## User Story

As a CRM user
I want to see a Customer's Contacts on the Customer detail page
So that I can review the relevant names, email addresses, and phone numbers without leaving the Customer context

## Problem Statement

The Contact list BFF read already accepts a `customerId`, but `CustomerDetailPage` currently calls only `getCustomerDetail` and renders no Contact information. Users therefore cannot see the Contacts associated with the Customer at `/cs/crm/customers/:id`.

## Solution Statement

Extend the existing Customer detail feature with a route-owned query adapter and an internal, prop-driven Contacts presentation component in the current page module. The adapter will call `getContactList` through `runEffectRequest`, pass the exact route Customer UUID plus bounded active-list pagination, exhaustively map the operation's typed BFF/client failures, and convert Contact responses into a plain row view model. The presentation component will render localized loading, empty, forbidden, not-found, unavailable/retry, and populated states using UI-kit `Table`, `Skeleton`, `StatusText`, `Button`, and existing responsive overflow conventions.

No new route, MicroVertical page, API, Action, persistence operation, or Module Federation exposure is needed. The existing generated `getContactList` BFF operation and `contactListRead` implementation remain the backend seam.

## Relevant Files

Use these files to implement the feature:

- `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx` — existing Customer detail route, Query Client boundary, BFF integration, view models, presentation states, and location for the new internal Contacts component.
- `verticals/crm/tests/components/customer-detail-page.test.tsx` — component coverage for the existing route; extend it to prove the Contacts BFF call, semantic table, states, retry/focus behavior, responsive overflow, and locale behavior.
- `verticals/crm/locales/cs/crm.json` — Czech Contacts heading, caption, columns, pagination, and state copy under the owning `customerDetail` namespace.
- `verticals/crm/locales/en/crm.json` — English keys matching the Czech catalog exactly.
- `verticals/crm/src/api/crm-client.ts` — generated Effect client facade already exporting `getContactList`; consume it without changing or bypassing the BFF client.
- `verticals/crm/shared/apis/contact-list.ts` — existing request/response schemas, bounded pagination contract, and closed typed error union that the feature must handle exhaustively.
- `verticals/crm/shared/apis/contact-detail.ts` — existing Contact fields used to define the plain table row view model.
- `verticals/crm/src/api/contact-list.read.ts` — existing governed read proving that Contacts are scoped to the supplied Customer and default to active records when `filter` is omitted or set to `active`.
- `verticals/crm/node_modules/@techsio/ui-kit/dist/src/organisms/table.d.ts` — installed UI-kit `0.25.1` Table API; use its semantic compound parts and supported `size="sm"` / `variant="line"` props.
- `verticals/crm/src/routes/[lang]/crm/customers/page.tsx` — established CRM pattern for UI-kit Table composition, skeleton geometry, local horizontal overflow, pagination, typed error mapping, and BFF query integration.
- `docs/frontend/FIGMA.md` — Figma is a wireframe for arrangement only; do not copy its styling.
- `docs/frontend/FRONTEND.md` — required separation between BFF/query integration, view models, and prop-driven presentation.

## Implementation Plan

### Phase 1: Foundation

Extend the Customer-detail component test fixture and locale copy contract for Contacts. Define a Customer-scoped Contact query key, page size, row view model, view-state union, and exhaustive Contact-list error classifier inside the existing page module. Keep the new component internal to the existing business page file, so this feature creates neither a new business file type nor a new Codesmith-governed page.

### Phase 2: Core Implementation

Add the internal Contacts presentation component below the ready Customer overview. Use semantic `Table.Caption`, `Table.Header`, `Table.Body`, `Table.Row`, `Table.ColumnHeader`, and `Table.Cell` parts with columns for Contact name, email, and phone. Preserve final table geometry during loading with UI-kit Skeleton rows, wrap the table in a local horizontal overflow boundary for narrow screens, and represent empty and failure states explicitly. Add accessible previous/next paging for the bounded BFF response without exposing raw query or Effect types to the presentation component.

### Phase 3: Integration

Use the existing Customer UUID and shared Query Client to invoke `getContactList` through `runEffectRequest` with the CRM API base URL, correlation ID, locale, `filter: 'active'`, and bounded `limit`/`offset`. Map the successful response to plain row props and the complete typed error union to localized UI states. Verify that invalid route IDs invoke neither Customer nor Contact reads and that the Shell route, federation exposure, generated BFF contract, and backend remain unchanged.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Specify the Customer-scoped Contacts behavior in component tests

- [x] Extend `verticals/crm/tests/components/customer-detail-page.test.tsx` with `getContactList` and `runEffectRequest` mocks that prove one valid Customer ID produces the exact bounded active-list payload and BFF options, while invalid route IDs produce no Contact call.
- [x] Add fixtures and assertions for semantic column headers and ordered rows containing Contact name, email, and phone, plus tests for active-list pagination, loading skeleton geometry, empty results, a parent-not-found response, definite forbidden behavior, authentication/unavailable retry, transport/decode/internal failures, keyboard activation, restored focus, responsive horizontal overflow, and Czech/English locale parity.

### 2. Add localized Contacts copy

- [x] Add matching `crm.pages.customerDetail.contacts` structures to `verticals/crm/locales/cs/crm.json` and `verticals/crm/locales/en/crm.json` for the section heading/table caption, name/email/phone columns, loading and empty messages, authentication, forbidden, parent-not-found, transport, decode, backend/internal unavailable states, retry/retrying labels, and pagination labels/actions.
- [x] Keep all visible and accessibility text in i18n catalogs and update the test translation fixture so no user-facing Contact copy is hardcoded in TSX.

### 3. Define the Contact-list adapter and closed view contract

- [x] In `verticals/crm/src/routes/[lang]/crm/customers/[id]/page.tsx`, import `getContactList`, its response type, and the installed UI-kit `Table`; add a bounded page-size constant, Customer-and-offset-specific query key, plain Contact row model, presentation copy/props, explicit loading/empty/populated/not-found/forbidden/authentication/unavailable states, and an exhaustive classifier for every `getContactList` backend, gateway, transport, and decode error.
- [x] Keep Effect values, BFF response/error types, React Query objects, routing, and authentication details outside the presentation component.

### 4. Build the internal Contacts table component

- [x] Add the internal prop-driven Contacts component in the existing Customer detail page module and render it after `ReadyCustomerDetail`, matching the Figma arrangement of a section heading followed by a full-width table while taking all appearance from `@techsio/ui-kit`.
- [x] Compose `Table` with `variant="line"`, `size="sm"`, semantic caption/header/body/row/cell parts, no custom/native table primitive, and no duplicated UI-kit appearance classes. Use layout-only CRM Tailwind classes for a minimum table width and a local `overflow-x-auto` boundary.
- [x] Render UI-kit Skeleton rows with `aria-busy` during loading; localized `StatusText` for empty, forbidden, parent-not-found, and unavailable states; a UI-kit retry Button only for authentication and retryable unavailable states; and accessible previous/next controls when the BFF returns another offset.

### 5. Connect the component to the generated BFF client

- [x] Within the existing Customer detail feature/query boundary, call `getContactList` through `runEffectRequest` using `{ customerId, filter: 'active', limit: CONTACT_LIST_PAGE_SIZE, offset }` and the same CRM base URL, locale, and correlation-ID conventions as the Customer detail read.
- [x] Map Contact responses to plain name/email/phone row models, drive pagination through bounded component-owned offset state, reset that offset when the Customer ID changes, and refetch only through the React Query seam. Do not import `contact-list-read-server`, persistence code, or `executeContactList`, and do not add ad hoc `fetch` or Promise error handling.
- [x] Ensure the Contacts query is disabled for an invalid route ID and the component is attached only to the existing `CustomerDetailPage`; do not scaffold or register another page.

### 6. Audit UI-kit and architectural boundaries

- [x] Review the final CRM page against the installed Table API and the UI-kit app-adoption rules: retain semantic table markup, supported props, token-owned appearance, and layout-only `className` usage; record a UI-kit gap instead of adding a native/custom table if an unsupported requirement appears.
- [x] Confirm locale parity, no new Shell route or Module Federation exposure, no backend/contract/generated-file edits, and no direct database or server implementation import in browser-facing source.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` from `app/` and resolve all failures without unrelated changes.

## Testing Strategy

### Unit Tests

Extend the existing Rstest Customer-detail component suite to cover the Customer-scoped query key/payload, closed error classification, row view-model output, semantic accessible table, loading geometry, empty/populated states, pagination, localization, responsive overflow, and retry/focus interactions. The tests must assert that the page calls the generated `getContactList` facade through `runEffectRequest` and never bypasses the BFF seam.

### Integration Tests

No new backend integration test is required because `verticals/crm/tests/integration/customer-contact-bff.test.ts` already exercises `getContactList` through the generated CRM client and `verticals/crm/tests/integration/customer-contact-operations.test.ts` already proves Customer scoping, pagination, and persistence behavior. Run the existing CRM integration suite to protect that seam while integrating the frontend.

### Edge Cases

- Invalid, missing, or overlong route IDs must not invoke either BFF read.
- A Customer with no active Contacts shows a localized empty state and no data rows.
- More than one page of Contacts exposes bounded previous/next navigation without mixing cached pages or Customer IDs.
- Contact text may be long; the table remains readable through its local horizontal overflow boundary without overflowing the Customer page.
- A Contact-list 404 caused by a concurrently removed Customer is distinct from an empty list and does not offer a futile retry.
- Definite forbidden errors do not offer retry; authentication expiration and retryable/unavailable failures do.
- Backend, gateway, transport, empty-body, and schema-decode failures are mapped exhaustively without leaking diagnostics.
- Retrying restores focus to the Contacts results region and remains keyboard operable.
- Archived Contacts are excluded by the explicit `filter: 'active'` request.

## Acceptance Criteria

- [x] `/cs/crm/customers/:id` and `/en/crm/customers/:id` remain the only routes involved; no new page or entrypoint is created.
- [x] A valid Customer detail shows a localized Contacts section below the Customer overview.
- [x] The populated section uses `@techsio/ui-kit/organisms/table` with semantic caption, column headers, body, rows, and cells for Contact name, email, and phone.
- [x] The frontend calls the generated `getContactList` BFF client through `runEffectRequest` with the route Customer UUID and bounded active-list pagination; it does not call backend or persistence code directly.
- [x] Loading, empty, populated, parent-not-found, forbidden, authentication-expired, transport, decode, unavailable, and internal failure states are explicit, localized, and accessible.
- [x] Retry is offered only for authentication/retryable failures, is keyboard operable, and restores focus to the Contacts result region.
- [x] Multiple pages can be traversed without mixing Contact data between Customers or offsets.
- [x] The table remains usable on narrow screens through a component-local horizontal scroll boundary.
- [x] Czech and English locale structures remain in parity and contain all visible/accessibility copy.
- [x] Existing Customer detail behavior and the CRM BFF/integration suites remain green.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:component -- customer-detail-page.test.tsx` — Run the focused Customer-detail and Contacts component coverage.
- `mise exec -- pnpm --filter @app/crm test:integration` — Protect the existing governed Contact-list and generated BFF seam.
- `mise exec -- pnpm --filter @app/crm typecheck` — Validate the CRM route, view-state unions, UI-kit props, and client typings.
- `mise exec -- pnpm i18n:boundaries` — Validate translation ownership and catalog boundaries.
- `mise exec -- pnpm api:check` — Confirm browser-facing code preserves the strict generated Effect BFF boundary.
- `mise exec -- pnpm module-entrypoints:check` — Confirm no ungoverned page or module entrypoint was introduced.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- The request names `GetContactListAction`; the existing repository contract names this read operation `getContactList`, backed by `contactListRead`. Implementation must reuse that generated BFF read. Creating a new state-changing Action would be architecturally incorrect and is out of scope.
- The user explicitly requested an internal component on `CustomerDetailPage`. Keeping it in the existing page module avoids creating a new business-functionality file type without a Codesmith generator. If implementation instead needs a separate business component file, Codesmith ownership must be resolved with the developer before that file is created.
- Figma MCP inspection reached the View-seat tool-call limit after the desktop canvas confirmed the exact `Pre-Alpha Repo` page and `Audit Log — Naplněný` frame. The captured wireframe still established the required arrangement: section heading above a full-width, line-separated table. Per `docs/frontend/FIGMA.md`, no Figma-specific visual values are carried into implementation.
- The installed UI-kit version is `0.25.1`; its checked-in dependency declarations confirm the Table API used by this plan. Cached skill metadata referenced an older library version, so the installed package remains authoritative.
- No unresolved decision blocks implementation while the component remains internal to the existing page module.

## Implementation Evidence

### Summary

- Added the localized Customer Contacts section to the existing Customer detail page, using the generated `getContactList` Effect BFF client, bounded active-list pagination, exhaustive typed failure mapping, plain view models, and the installed UI-kit Table/Skeleton/StatusText/Button components.
- Added component coverage for the request seam, semantic and responsive UI, loading/empty/populated/error states, pagination isolation/reset, localization, keyboard retry/focus restoration, and the standalone dynamic-route adapter.

### Changed Files

```text
app/verticals/crm/locales/cs/crm.json              |  27 ++
app/verticals/crm/locales/en/crm.json              |  27 ++
.../src/routes/[lang]/crm/customers/[id]/page.tsx  | 436 ++++++++++++++++++++--
.../tests/components/customer-detail-page.test.tsx | 352 +++++++++++++++++--
app/specs/feature-crm-customer-contacts-table.md    | implementation plan and evidence
```

### Tests Written or Updated

- `verticals/crm/tests/components/customer-detail-page.test.tsx` — proves the exact Customer-scoped active Contact request/options, invalid-route suppression, table semantics and ordering, loading geometry, all explicit states, exhaustive client error mapping, bounded/cache-isolated pagination, Customer reset, locale parity, responsive overflow, keyboard retry/focus, and standalone route parameters.

### Validation

- `mise exec -- pnpm --filter @app/crm test:component -- customer-detail-page.test.tsx` — passed; 5 component files and 92 tests passed.
- `DATABASE_ADMIN_URL=postgresql://ontos_admin:ontos_admin@localhost:55433/ontos DATABASE_URL=postgresql://ontos_runtime:ontos_runtime@localhost:55433/ontos ONTOS_RUNTIME_DB_PASSWORD=ontos_runtime SPICEDB_ENDPOINT=localhost:50051 SPICEDB_PRESHARED_KEY=ontos-local-development-key SPICEDB_INSECURE=true mise exec -- pnpm --filter @app/crm test:integration` — passed; 3 integration tests passed against a disposable PostgreSQL 17 container and the local SpiceDB test service.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check` — passed, including formatting, lint, 58 Action unit tests, root typecheck, boundary/contract checks, and performance readiness.
- `GIT_CEILING_DIRECTORIES=/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-wt-crm-customer-contacts-table ULTRAMODERN_SOURCE_REVISION=cad97ee5ce3fa0bd5b37abe00b5699cf96794f8f mise exec -- pnpm build` — passed for CRM, Shell, Module Federation type assertions, and performance readiness.
- Browser smoke check at `http://localhost:4101/en/crm/customers/not-valid` — passed after the review fix; localized not-found content rendered with no browser console warnings/errors. Screenshot: `.codex/reports/review/feature-crm-customer-contacts-table/customer-detail-invalid-route.png`.

### Review

- Re-read and reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, MicroVertical, Action, Effect error, UltraModern, frontend, Figma, relevant product architecture, the installed UI-kit Table declaration, and the complete specification.
- Confirmed the generated Effect client remains the only frontend/backend seam; no new route, business file, Shell/Module Federation exposure, backend/contract/generated source, direct persistence/server import, native table/button, plain CSS, or cross-MicroVertical dependency remains in the diff. No Codesmith generator applied because no governed business artifact was created.
- Browser validation found the standalone Customer detail route still default-exported the prop-requiring component and crashed during SSR without `routeParams`. Fixed it with the established `useParams` standalone adapter pattern and added a regression test. A production build regenerated unrelated stale Shell route files; those accidental changes were removed before completion.

### Deviations and Follow-ups

- The literal first `mise exec -- pnpm build` reached the repository release-envelope check and rejected the detached dirty worktree's default `workspace` revision. The final revision-aware build command above passed completely; no implementation defect remained.
- The first integration attempt had no isolated `DATABASE_URL`. The final suite passed against a disposable migrated PostgreSQL container, which was stopped and removed after validation. No persistent database data was changed.
- No blockers or follow-ups remain.
