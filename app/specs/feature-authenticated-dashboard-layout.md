---
type: feature
status: superseded
created: 2026-08-06
---

# Feature: Authenticated dashboard layout

> [!IMPORTANT]
> **Historical scope:** [OntOS #78](https://github.com/TechsioCZ/ontos/issues/78) and [the Tenant switcher specification](./feature-tenant-switcher.md) supersede this feature's disabled-placeholder/no-switching constraint. The feature remains a record of the original dashboard delivery, not the current account-tenancy model.

## Feature Description

Add the default signed-user dashboard layout requested by GitHub issue #77. The layout is an
opt-in Shell presentation wrapper for authenticated pages, not global route chrome: each signed-in
page can supply its own localized page title and active navigation key while the authenticated home
page uses the default Home configuration.

The layout follows the arrangement in Figma project `ERP`, page `Pre-Alpha Repo`, frame
`Home — Aktivní modul` (`6:399`): a left sidebar contains the OntOS brand, an intentionally empty
and disabled tenant Select placeholder, a Home link, and links for the signed-in tenant's installed
active MicroVerticals. The main area starts with a `@techsio/ui-kit` Header whose rightmost element
is a `Menu` triggered by the signed user's display name. That Menu contains exactly one command:
logout. Search is omitted. The current authenticated home identity and active-module content remain
the page body, with logout moved from its standalone button into the Header Menu.

Treat Figma only as a wireframe for component arrangement. Use the installed
`@techsio/ui-kit@0.25.1` components, component tokens, and Tailwind layout utilities instead of
copying Figma colors, measurements, or visual styling.

## User Story

As a signed-in OntOS user
I want a consistent dashboard layout with module navigation and an account menu
So that I can recognize my current workspace, navigate to an active MicroVertical, and log out
from every authenticated page

## Problem Statement

The Shell home route currently renders authenticated identity, active MicroVertical state, and a
standalone logout button inside a centered full-screen section. The existing `shell-frame.tsx` is
unused legacy shell chrome, depends on a custom generated header/status presentation, and cannot
receive the current identity, module list, page title, or logout state. The global `layout.tsx`
deliberately renders only the route outlet, so applying dashboard chrome globally would also wrap
anonymous and login pages incorrectly.

The current authenticated loader already provides the safe display name and an ordered list of
installed MicroVerticals whose persisted tenant state is exactly `active`. The missing capability
is therefore presentation and page-level composition, not another BFF endpoint, Core query,
Action, or client-side fetch.

## Solution Statement

Refactor the existing `shell-frame.tsx` module into an `AuthenticatedDashboardLayout` component.
Give it a small page configuration (`title` and optional current MicroVertical key), the safe
authenticated identity, the active-module items, logout pending state, and a semantic logout
callback. The component will own the responsive sidebar and Header/Menu chrome while rendering
page-specific children in the main content area. An absent current MicroVertical key means Home is
the active navigation entry, which makes the authenticated home configuration the default while
allowing a later page to opt into the same layout with its own title and active module.

Use `@techsio/ui-kit/organisms/header` for the main-area header,
`@techsio/ui-kit/molecules/menu` with one data-driven action item and `triggerText` equal to
`identity.displayName`, `@techsio/ui-kit/molecules/select` for the disabled empty placeholder, and
`@techsio/ui-kit/atoms/link` with the Modern i18n Link adapter for client-side localized
navigation. Use a semantic native `aside` because the installed UI kit has no Sidebar component.
Use only Tailwind layout utilities around UI-kit components; do not duplicate their appearance
with component `className` overrides or add plain CSS.

Render this layout only from the authenticated branch of `HomeView`. Keep the anonymous branch,
session and active-module loader, strict Effect client, and BFF contracts unchanged. Keep the
existing identity details, active-module list, unavailable feedback, and logout success/failure
state behavior in the page body. Replace only the standalone logout Button with the Menu command.

## Relevant Files

Use these files to implement the feature:

- `AGENTS.md` — authoritative application architecture, UI, i18n, and managed-toolchain rules.
- `docs/frontend/FRONTEND.md` — Shell presentation boundaries, UI-kit use, localization, state, accessibility, and responsive behavior.
- `docs/frontend/FIGMA.md` — limits the Figma source to arrangement and requires UI-kit visuals.
- `apps/shell-super-app/src/routes/shell-frame.tsx` — existing file to refactor into the configurable authenticated dashboard layout without creating a new component file.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — authenticated/anonymous branching, existing page body, and logout state to integrate with the layout.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — existing serializable identity and exact-active installed MicroVertical data source; reuse without widening its contract.
- `apps/shell-super-app/src/api/auth-client.ts` — existing contract-derived `signOut` Effect client that the page callback must continue to invoke.
- `apps/shell-super-app/shared/api.ts` — authoritative safe identity and active-module response schemas; no contract change is expected.
- `apps/shell-super-app/src/routes/layout.tsx` — global outlet-only layout that must remain free of signed-user chrome.
- `apps/shell-super-app/locales/en/shell.json` — English dashboard, navigation, empty Select, account Menu, and accessibility copy.
- `apps/shell-super-app/locales/cs/shell.json` — matching Czech copy.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — existing layout test file to extend with dashboard layout semantics and configuration coverage.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — authenticated composition, active links, Menu logout, pending/failure, and unchanged anonymous/page-content coverage.
- `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` — English/Czech locale-key parity coverage to extend for the dashboard namespace.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — real localized session, Menu logout/retry, keyboard, and narrow-viewport behavior.
- `apps/shell-super-app/src/routes/index.css` — existing UI-kit token/Tailwind imports; inspect only and change only if a failing implementation proves a missing app semantic token.
- `../docs/adr/0014-authenticated-principal-session.md` — defines the safe signed-in OntOS identity boundary.
- `../docs/05_MICROVERTICALS.md` — product context for tenant module visibility and Shell navigation.

## Implementation Plan

### Phase 1: Foundation

Turn the existing unused shell frame into a typed, page-configurable authenticated layout while
preserving the global outlet-only layout. Define navigation directly from the existing safe
identity and active-module view model; do not add a store, context, hook, BFF operation, or module
registry. Add component tests at the same time to lock the layout's page configuration and
landmark contract.

### Phase 2: Core Implementation

Compose the responsive sidebar, empty disabled Select, localized Home/module links, UI-kit Header,
and one-item user Menu. Move logout invocation into the Menu callback without weakening the
existing duplicate-submit guard, success transition, or retryable error state. Keep authenticated
page content as children and keep anonymous rendering outside the layout.

### Phase 3: Integration

Add aligned English/Czech copy and prove the full session flow at desktop and mobile widths. Cover
empty and unavailable active-module data, deterministic links, keyboard Menu use, logout pending,
failure/retry, and the complete removal of authenticated chrome after successful logout. Run the
focused Shell gates, production build, and final repository check from `app/`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the page-configurable authenticated dashboard contract

- [x] Refactor `apps/shell-super-app/src/routes/shell-frame.tsx` in place so its public component is named `AuthenticatedDashboardLayout`; accept `children`, a localized `title`, `identity`, the existing `ActiveModules` items, an optional `currentModuleKey`, `logoutPending`, and `onLogout`, with no new application component file.
- [x] Treat `currentModuleKey === undefined` as the default Home configuration; use a matching module key to mark a MicroVertical navigation entry current on later pages, without adding route inspection, React context, or a global mutable registry.
- [x] Keep application state and Effects outside the Shell layout integration: it emits only the semantic `onLogout` callback and does not call the Effect client, read loader data, navigate imperatively, or own authenticated server state. It may render declarative localized Links because route navigation is part of the Shell integration boundary.
- [x] Extend `apps/shell-super-app/tests/unit/layout.test.tsx` beside the contract change to prove the root `Layout` still exposes only its outlet and the authenticated layout accepts alternate titles/current-module configurations without changing page children.

### 2. Compose the sidebar and responsive layout from supported primitives

- [x] In `shell-frame.tsx`, replace the legacy custom `Header`/`StatusBadge` imports with the installed UI-kit `Header`, `Menu`, `Select`, and `Link`, adapting Link to the existing Modern i18n router Link so navigation remains localized and client-side.
- [x] Render a semantic `aside` with the OntOS brand, an accessible disabled `Select` whose `items` and value remain empty, a localized Home link, and one link per provided active MicroVertical. Preserve loader order, use the stable `moduleKey` as the honest label, pass `/${moduleKey}` to the Modern i18n Link adapter, and assert its rendered localized `/${language}/${moduleKey}` landing URL without introducing display-name or route metadata that the current contract does not publish.
- [x] Use valid `@techsio/ui-kit@0.25.1` Select anatomy (`Label`, `Control`, `Trigger`, `ValueText`, `Positioner`, and empty `Content`) and Link adapter props. Do not use a native `<select>` or `<a>`, invent props, add tenant switching, or add Figma-derived component styling.
- [x] Use Tailwind layout utilities to place the sidebar left of the main region on wide viewports and before it on narrow viewports, with no fixed Figma dimensions, clipped content, horizontal page overflow, or inaccessible off-canvas navigation.
- [x] Add layout tests for the sidebar/navigation landmarks, brand, disabled empty Select, Home-current state, active-module link count/order/URLs, zero-module state, current-module state, focusable links, and absence of inactive values not supplied through the exact-active view model.

### 3. Build the main-area Header and account Menu

- [x] Render the page title in a UI-kit `Header` at the top of the main region and place `Header.Actions` last so the signed-user `Menu` is the rightmost Header element; omit search, language switching, badges, and unrelated actions.
- [x] Model the Menu with one `MenuItem` of type `action`, value `logout`, and localized label. Set `triggerText` to `identity.displayName`, give the Menu an accessible localized account label, and call `onLogout` only when the selected value is exactly `logout`.
- [x] While `logoutPending` is true, retain the user's trigger text, change the sole item's label to the existing localized pending copy, disable that item, and preserve the page-level duplicate-invocation guard. Do not replace Menu with a custom dropdown or style its trigger/content internals.
- [x] Extend layout tests to prove the Header title, rightmost user trigger, exactly one Menu command, keyboard-open/select behavior supplied by Menu, exact logout dispatch, ignored unknown values, and disabled pending command.

### 4. Integrate the default dashboard into authenticated Home

- [x] In `apps/shell-super-app/src/routes/[lang]/page.tsx`, keep the anonymous branch byte-for-behavior equivalent and wrap only the authenticated branch in `AuthenticatedDashboardLayout` with the localized Home title, safe identity, existing active-module items, pending state, and existing guarded logout handler.
- [x] Keep the authenticated identity `<dl>`, semantic active-module `<ul>`, exact ordering, empty list, and unavailable feedback as page children. Remove the standalone logout Button because logout now belongs exclusively to the Header Menu, and remove only the authenticated full-screen/background responsibilities now owned by the layout.
- [x] Preserve logout behavior: success atomically replaces the authenticated model with the anonymous view and removes all dashboard chrome; failure retains identity, navigation, page data, and localized retryable `StatusText`; a later Menu selection retries the same contract-derived Effect.
- [x] Update `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` with UI-kit/router mocks only where required and prove unchanged anonymous output, authenticated content inside the layout, active module navigation, zero/unavailable module states, one account trigger and one logout command, pending duplicate protection, successful teardown, failed retry, and absence of password/token data.

### 5. Localize and prove browser behavior

- [x] Add aligned `shell.dashboard` keys to both Shell locale files for the Home title, dashboard/sidebar/account navigation labels, empty tenant Select label, and any new accessibility text; reuse existing auth logout pending/failure/action keys instead of duplicating them.
- [x] Extend `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` to prove exact English/Czech dashboard-key parity and retain the existing login and active-module contracts.
- [x] Update `apps/shell-super-app/tests/e2e/login.spec.ts` so authenticated English/Czech flows open the display-name Menu and choose its logout command. Prove reload persistence, failure/retry, cookie-cleared anonymous teardown, and that anonymous/login pages never render the dashboard.
- [x] Add authenticated keyboard coverage for focusing/opening the account Menu, reaching its only command, and returning to an operable trigger after a failed request. Add a 375px-wide authenticated assertion that sidebar, Header, Menu trigger, and page content remain reachable without horizontal page overflow.

### 6. Run all validation commands

- [ ] From `app/`, execute every command under Validation Commands in order, resolve every failure without changing BFF/Core contracts or files outside `app/`, then inspect `git diff --check` and final `git status --short`.

## Testing Strategy

### Unit Tests

Use the existing Shell component test files to cover the layout's typed page configuration,
semantic landmarks, UI-kit composition, localized Link adapter, disabled empty Select, exact-active
module links, Home/module current state, page-title substitution, one-item account Menu, pending
disablement, semantic logout callback, authenticated composition, anonymous isolation, existing
content, logout success/failure, redaction, and English/Czech locale parity.

### Integration Tests

Use the existing Playwright authentication fixture and real Shell BFF to prove that a valid session
renders the layout, survives reload, invokes the existing sign-out endpoint through the Menu,
clears the cookie and dashboard after success, and retains an accessible retry path after a failed
request. Exercise desktop and narrow viewports plus keyboard Menu navigation. No new backend or
database integration test is required because the identity, active-module read, and sign-out
contracts are reused unchanged and already have focused runtime coverage.

### Edge Cases

- The home route is anonymous, the login route is visible, or the authenticated session becomes invalid.
- The identity display name is long enough to require truncation without hiding the accessible Menu name.
- The authenticated tenant has zero installed active MicroVerticals.
- The active-module read is unavailable while the authenticated identity remains valid.
- Active module keys contain allowed hyphens or dots and still produce encoded/localized navigation targets.
- A logout command is selected repeatedly while the first request is pending.
- Logout fails once and succeeds on a later Menu selection.
- The viewport is narrow, content is long, or the user relies on keyboard focus instead of a pointer.
- A later authenticated page supplies a different title and current MicroVertical key.

## Acceptance Criteria

- [x] Anonymous home and login pages render exactly their existing page-specific UI and no dashboard sidebar, Header, user Menu, or active-module navigation.
- [x] The authenticated home opts into `AuthenticatedDashboardLayout` with Home as its default current navigation entry; the global route layout remains outlet-only.
- [x] The wide layout places a semantic sidebar to the left of the main region; the narrow layout keeps sidebar, Header, Menu, and content reachable with no horizontal page overflow.
- [x] The sidebar contains the OntOS brand, one accessible disabled empty UI-kit Select, Home, and one localized client-side Link for every provided installed active MicroVertical in deterministic order.
- [x] Zero active MicroVerticals leaves Home as the only navigation link; an unavailable module read retains authenticated chrome and the existing accessible unavailable feedback.
- [x] The main-area UI-kit Header shows the configured localized page title and has the display-name Menu as its rightmost element; search and unrelated Header actions are absent.
- [x] The Menu trigger text is the signed user's safe `displayName` and its command list contains exactly one localized logout action.
- [x] Logout pending state prevents duplicate invocation, success removes identity/page data/dashboard together and shows only the anonymous state, and failure retains the dashboard with accessible localized retry feedback.
- [x] The authenticated page keeps its existing safe identity details and semantic active-module list; it contains no standalone logout Button and exposes no password, cookie, token, or additional identity data.
- [x] Each authenticated page can configure its title and current MicroVertical through typed layout props without changing the global layout or duplicating the dashboard structure.
- [x] The implementation uses the pinned UI-kit Header, Menu, Select, and Link APIs plus a semantic native `aside`; it adds no custom dropdown/select/link primitive, plain CSS, Figma-specific visuals, UI-kit library change, backend contract, Action, or new application component file.
- [x] English and Czech copy remain structurally aligned, and unit/E2E tests cover keyboard, responsive, empty, unavailable, pending, failure, retry, and successful logout paths.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run layout, authenticated home, localization, contract, and existing Shell unit coverage.
- `mise exec -- pnpm --filter @app/shell-super-app typecheck` — typecheck the pinned UI-kit component APIs, Modern Link adapter, layout props, and tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — prove real localized login/session/Menu logout/retry plus keyboard and narrow-viewport behavior.
- `mise exec -- pnpm i18n:boundaries` — validate Shell locale ownership and user-facing string boundaries.
- `mise exec -- pnpm api:check` — prove the frontend refactor did not cross strict Effect BFF server/browser boundaries.
- `mise exec -- pnpm contract:check` — validate route, topology, ownership, and generated workspace contracts.
- `mise exec -- pnpm build` — build the production Shell and its Module Federation/public-surface integration.
- `git diff --check` — detect whitespace errors and conflict markers.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Prepared from `develop` at commit `482cd1467ecdcbe1e42aa34f3c2be03a60b57d1c`; the planning worktree was detached at that exact commit and clean before this plan was added.
- Figma source: `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=6-399`, project `ERP`, page `Pre-Alpha Repo`, frame `Home — Aktivní modul`. The Figma design-context API was unavailable because the authenticated Professional View seat had reached its MCP call limit; the exact frame and arrangement were inspected read-only in Figma Desktop. This does not block implementation because repository guidance treats Figma as arrangement-only and the issue explicitly enumerates the required components and omissions.
- The installed app dependency is `@techsio/ui-kit@0.25.1`, while the bundled usage-skill metadata describes `0.3.2`. The `0.25.1` published declarations were inspected directly and confirm the planned Header parts, Menu `triggerText`/action item API, Select anatomy/disabled empty collection, and polymorphic Link adapter. The pinned package remains authoritative during implementation.
- The empty Select is deliberately disabled and has no options or selected value. The current product model gives one BetterAuth account exactly one tenant and explicitly rejects tenant switching; adding a tenant chooser would conflict with `../docs/20_DAY_3_GRILL_RESULTS_FOR_ARCHITECT.md` and is outside issue #77.
- The existing Shell endpoint returns only installed tenant modules with state exactly `active`, matching issue #77 and the completed `specs/feature-tenant-microvertical-state-list.md`. Older product guidance says normal navigation may eventually include `read_only` and `deprecated` modules with state indicators; widening the current Effect contract and navigation states is a separate feature.
- `moduleKey` is currently the only published navigation identity/display value. This plan uses it as both the visible label and the localized landing-route segment instead of inventing a Module Manifest display name or route registry. When richer topology/navigation metadata becomes authoritative, the layout can consume that view model without changing its visual contract.
- No Codesmith generator applies: the implementation reuses existing frontend, locale, and test files and creates no Action, MicroVertical page, Outbox Message, Policy, or new business-component file.
- No unresolved developer decision blocks implementation.

## Implementation Evidence

### Summary

- Refactored the legacy Shell frame into a typed, page-configurable authenticated dashboard layout using the pinned UI-kit Header, Menu, Select, and Link APIs.
- Integrated the layout only into authenticated Home, preserving the anonymous branch, loader/BFF contracts, identity and module content, and guarded Effect sign-out flow.
- Added aligned English/Czech dashboard copy plus component, route, localization, keyboard, responsive, failure/retry, and teardown coverage.
- Narrowed the reusable layout to presentation-owned account and navigation view models instead of raw BFF response types, with route-level adaptation in `HomeView`.

### Changed Files

8 tracked files changed, 522 insertions(+), 90 deletions(-). The supplied untracked plan file was updated in place with status, task checkboxes, and this evidence.

### Tests Written or Updated

- `apps/shell-super-app/tests/unit/layout.test.tsx` — layout configuration, landmarks, Select, localized navigation/current state, Header/Menu ordering, keyboard dispatch, unknown selection, and pending disablement.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — anonymous isolation, authenticated composition/content, exact-active navigation, empty/unavailable states, pending duplicate protection, logout success, and failure/retry.
- `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` — exact English/Czech dashboard namespace parity while retaining login and module contracts.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — real English/Czech session, explicit dashboard isolation on both login routes, reload, Menu logout, transport failure/retry, keyboard reachability/focus restoration, anonymous teardown, and 375px overflow behavior.

### Validation

- `mise exec -- pnpm --filter @app/shell-super-app exec rstest tests/unit/layout.test.tsx tests/unit/routes/home/page.test.tsx tests/unit/routes/login/locales.test.ts` — passed, 18/18 focused unit tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — failed on two unrelated baseline assertions; 49 tests passed, while `auth-boundary.test.ts` and `installed-verticals.test.ts` expect `testing1` although the committed starting topology has `verticals: []`.
- `mise exec -- pnpm --filter @app/shell-super-app typecheck` — failed on pre-existing TS-Go project-reference declaration errors (`TS6305`) and their existing Effect typing cascade; the changed layout emitted no diagnostic. Supplemental `mise exec -- pnpm typecheck` passed, and the production build's TS-Go compile passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — passed, 8/8 Chromium tests, with documented local development variables and an ephemeral gateway key supplied explicitly.
- `mise exec -- pnpm i18n:boundaries` — passed after replacing literal visible test props with named fixtures.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm contract:check` — failed before feature validation because the starting worktree contains neither `.agents/skills-lock.json` nor `.codex/skills-lock.json`.
- `mise exec -- pnpm build` — passed, including TS-Go compile, Module Federation types, and performance readiness.
- `git diff --check` — passed.
- `mise exec -- pnpm check` — failed at the first format gate on the unrelated pre-existing `packages/core-runtime/tests/unit/outbox-process.test.ts`; rerun after review produced the same result.
- `mise exec -- pnpm lint` — passed as supplemental changed-code validation.
- `mise exec -- pnpm typecheck` — passed as supplemental root type validation for the narrowed presentation contract.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, MicroVertical, Action, Effect error, UltraModern, frontend, Figma, authenticated-session, and product MicroVertical guidance; no boundary, contract, generator, or product-context violation remains.
- Ran the UI-kit app adoption audit against the changed routes. No native/custom primitive, invented prop, component appearance override, token gap, new component, or library-side change was found; token-backed backgrounds are limited to layout composition.
- Fixed review findings: redundant E2E coverage, deterministic keyboard reachability/failure retry, i18n test literals, and changed-file lint style issues.
- Fixed follow-up review findings by removing raw BFF response types from the reusable layout contract and adding explicit English/Czech login-page dashboard-isolation coverage.
- Browser review screenshots: `.codex/reports/review/feature-authenticated-dashboard-layout/desktop.png` and `.codex/reports/review/feature-authenticated-dashboard-layout/mobile-375.png`.

### Deviations and Follow-ups

- Status is `blocked`, not `done`, solely because required repository validation cannot pass on the untouched starting baseline: stale `testing1` topology assertions, missing skill lockfiles, Shell-only TS-Go reference-cache failures, and unrelated Core test formatting.
- Initial frozen install hit the same missing skill-lock postinstall failure; dependencies were completed with `--ignore-scripts` and the lockfile remained unchanged.
- The developer explicitly accepted the long-display-name clipping and missing long-name edge-case coverage as temporary-layout limitations; they remain unchanged.
- No feature-scope deviation, backend contract change, generator use, or unresolved product decision.
