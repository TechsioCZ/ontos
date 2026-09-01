---
type: feature
status: done
created: 2026-08-06
---

# Feature: Tenant switcher

## Feature Description

Implement the authenticated Shell tenant switcher requested by GitHub issue #78. The dashboard
sidebar's current disabled empty Select will show every active OntOS tenant available to the signed
Better Auth user, identify the tenant currently selected by that browser session, and let the user
change the session's trusted tenant context.

Core remains the authority for tenant access: an available tenant is one reached through an active
`core.principal_auth_bindings` row for the Better Auth user, an active tenant-scoped Principal, and
an active Tenant. Better Auth stores only the active tenant ID on its private session row. It does
not become a second tenant, membership, Principal, role, or authorization model, and the Better
Auth Organization plugin is not introduced.

After a successful switch, reload the current localized page as a new document so every route
loader, active-module read, future MicroVertical client, and issued gateway assertion is rebuilt
from the newly selected trusted tenant context. A failed switch must leave the prior session
context and rendered data intact and expose a localized retry path.

## User Story

As a signed-in user with access to more than one tenant
I want to see and select my current tenant in the dashboard sidebar
So that every OntOS page and MicroVertical operation runs in the tenant context I chose

## Problem Statement

`AuthenticatedDashboardLayout` currently renders an intentionally empty, disabled UI-kit Select.
The current Core principal resolver deliberately treats more than one active binding for one Better
Auth user as ambiguous, while the Better Auth session has no selected tenant field. Consequently,
the Shell cannot list multiple tenant choices, cannot resolve one tenant-scoped Principal for a
multi-tenant user, and cannot persist a choice across a reload.

This is an explicit product-model change from the accepted repository-level guidance in
`../docs/CONTEXT.md` and `../docs/20_DAY_3_GRILL_RESULTS_FOR_ARCHITECT.md`, which says one Better Auth
account belongs to exactly one tenant and forbids a selector. Issue #78 supersedes that constraint
for this feature, but it does not make a Principal global: one Better Auth user may have multiple
active bindings, and each binding still selects a distinct tenant-scoped Principal.

## Solution Statement

Extend the Core `PrincipalResolver` with two explicit capabilities: list the safe active tenant
choices for a Better Auth user and resolve that user for one exact selected tenant. Preserve
fail-closed behavior for missing, inactive, revoked, disabled, or unavailable records. Order the
visible choices by tenant name and tenant ID; for a newly created or legacy session without a
selection, choose the oldest eligible binding by `createdAt`, breaking ties by tenant ID. This
preserves the existing tenant as the default when additional bindings are added later. Never
silently fall back when an already selected tenant becomes invalid.

Add nullable `active_tenant_id` to the Shell-owned `auth.session` Drizzle schema and configure it as
a Better Auth session additional field. The session-creation hook writes the deterministic default,
and a legacy session with no value is upgraded lazily through Better Auth's own `updateSession` API.
The field is accepted only through the server-side Better Auth instance behind the strict Effect
BFF; no raw Better Auth route is exposed. The selected value is revalidated against Core on every
session resolution, so the Auth row is context state, never authorization evidence.

Publish contract-derived Effect operations to list available tenants and switch the current
session. The switch operation validates the target against Core before calling Better Auth
`updateSession`, returns only a safe selected tenant ID, and maps anonymous, forbidden,
unavailable, and unexpected failures to declared RFC 9457 Problem Details. Selecting the already
active tenant is idempotent. Authentication/session creation, revocation, and tenant selection are
Shell-owned Better Auth session mechanics, following the existing sign-in/sign-out boundary; they
do not mutate canonical Core business state and do not run through the Action runtime.

Replace the placeholder with a controlled `@techsio/ui-kit@0.25.1` Select using its complete
compound anatomy and array value. Keep Effects and reload behavior in `HomeView`; the reusable
layout receives tenant view models, explicit availability/pending/failure state, and a semantic
`onTenantChange` callback. Disable the Select when choices are unavailable, while a switch is
pending, or when no alternative tenant exists. On success, perform a full document reload. On
failure, keep the previous controlled value and show localized `Select.StatusText` feedback.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — app-only scope and mandatory Codesmith generator rules.
- `AGENTS.md` — authoritative Shell/Core, Effect, database, Action, and frontend boundaries.
- `docs/architecture/MICROVERTICALS.md` — Shell-owned authentication boundary and propagation of
  trusted tenant context to independently deployed MicroVerticals.
- `docs/architecture/ACTIONS.md` — clarify why Better Auth session-context lifecycle is not a
  canonical business-state Action while keeping every business state change Action-driven.
- `docs/architecture/ERRORS.md` — declared typed BFF errors, Problem Details, and generated client
  error channels.
- `docs/architecture/DATABASE.md` — typed Drizzle schema, generated migration, and Effect service
  database rules.
- `docs/frontend/FRONTEND.md` — route/feature ownership, generated Effect client use, UI states,
  localization, accessibility, and responsive behavior.
- `packages/core-runtime/src/auth/principal-resolver.ts` — current single-binding resolver to split
  into safe tenant listing and exact selected-tenant resolution.
- `packages/core-runtime/src/auth/principal-resolver-errors.ts` — closed typed resolution failures.
- `packages/core-runtime/src/index.ts` — narrow public Core resolver types and service surface.
- `packages/core-runtime/tests/unit/principal-resolver.test.ts` — pure classification, default
  choice, ordering, and fail-closed coverage.
- `packages/core-runtime/tests/integration/principal-resolver.test.ts` — real cross-tenant binding,
  Principal, and Tenant query behavior.
- `apps/shell-super-app/api/auth/db/schema.ts` — private Better Auth session schema and
  `activeTenantId` column.
- `apps/shell-super-app/drizzle.auth.config.ts` — authoritative Shell Auth migration generator
  configuration.
- `apps/shell-super-app/api/auth/service.ts` — Better Auth creation hook, current-session
  resolution, safe tenant list, switch, and legacy-session upgrade.
- `apps/shell-super-app/api/auth/errors.ts` — typed runtime failures needed to distinguish an
  unauthenticated session, forbidden target tenant, unavailable dependency, and defect.
- `apps/shell-super-app/shared/api.ts` — safe tenant schemas, list/switch endpoints, Problem Details,
  and stable paths.
- `apps/shell-super-app/api/index.ts` — strict Effect handlers, exhaustive runtime-error mapping,
  cookie forwarding, and unexpected-defect containment.
- `apps/shell-super-app/src/api/auth-client.ts` — contract-derived list and switch Effects with
  operation-specific typed error unions.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — serializable tenant-list UI state beside
  the existing session and active-module loader state.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — guarded switch Effect, failure state, and full
  document reload at the framework edge.
- `apps/shell-super-app/src/routes/shell-frame.tsx` — controlled UI-kit Select presentation and
  semantic tenant-selection callback.
- `apps/shell-super-app/locales/en/shell.json` — English tenant loading, selected, pending,
  unavailable, and failure copy.
- `apps/shell-super-app/locales/cs/shell.json` — structurally matching Czech tenant copy.
- `apps/shell-super-app/tests/unit/auth-schema.test.ts` — typed Auth session-column contract.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — endpoint, schema, path, and redaction
  contracts.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — real Better Auth/Core session,
  multi-tenant list/switch persistence, authorization, module, and gateway context behavior.
- `apps/shell-super-app/tests/unit/routes/home/loader.test.ts` — independent tenant-list loading and
  failure mapping without discarding a valid identity.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — Select anatomy, values, accessibility,
  availability, pending, failure, and callback behavior.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — guarded switch invocation, prior
  context retention on failure, duplicate prevention, and reload on success.
- `apps/shell-super-app/tests/unit/routes/login/locales.test.ts` — exact English/Czech key parity.
- `apps/shell-super-app/tests/e2e/auth-fixture.ts` — one Better Auth user with two deterministic
  tenant-scoped Principal bindings.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — browser selection, full reload, persistence,
  failure/retry, keyboard, and narrow-viewport behavior.
- `../docs/CONTEXT.md`, `../docs/20_DAY_3_GRILL_RESULTS_FOR_ARCHITECT.md`, and
  `../docs/adr/0014-authenticated-principal-session.md` — read-only product context whose previous
  single-tenant decision is superseded by approval of this plan.

### New Files

- `apps/shell-super-app/drizzle-auth/0001_*.sql` — generated addition of nullable
  `auth.session.active_tenant_id`; retain the actual suffix emitted by the repository Drizzle script.
- `apps/shell-super-app/drizzle-auth/meta/0001_snapshot.json` — generated schema snapshot paired with
  the migration; update the journal only through Drizzle generation.

## Implementation Plan

### Phase 1: Foundation

Document the new multi-tenant session interpretation, then replace ambiguous user-only resolution
with explicit Core queries for available tenant-scoped identities and one selected identity. Extend
the private Better Auth session schema and generate its migration. Establish deterministic initial
and legacy-session selection while keeping invalid existing selections fail-closed.

### Phase 2: Core Implementation

Publish strict Effect list/switch contracts and handlers, derive client Effects from those
contracts, and wire the controlled UI-kit Select into the existing authenticated dashboard. Keep
the previous tenant rendered until the backend confirms the switch; reload the whole localized
document only after success.

### Phase 3: Integration

Exercise one Better Auth user bound to two tenant-scoped Principals through Core resolution, Auth
session persistence, active-module reads, gateway assertions, localized UI, keyboard interaction,
failure/retry, and a narrow viewport. Run database, focused, contract, build, and repository gates.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Record the approved authentication-context model

- [x] Update the Authentication Boundary in `docs/architecture/MICROVERTICALS.md` to state that one
      Better Auth user may resolve to multiple tenant-scoped Principals, while exactly one active tenant
      ID from the current Better Auth session selects the trusted Principal and tenant context used for
      reads, gateway assertions, and Actions.
- [x] Update `docs/architecture/ACTIONS.md` narrowly: Better Auth credential and session lifecycle
      operations—sign-in, sign-out/revocation, refresh, and active tenant selection—are Shell-owned
      authentication mechanics rather than canonical business-state mutations. They use the strict
      typed Auth BFF and must not update Core business tables, emit Domain Events, or bypass Action rules
      for any later business change.
- [x] State in both changes that Core Principal Auth Bindings remain the tenant-access authority and
      that the selected Auth session field grants no permission. Do not introduce a global Principal,
      Better Auth Organization/member tables, an Auth MicroVertical, or a generic context store.

### 2. Make Core principal resolution tenant-aware

- [x] Refactor `packages/core-runtime/src/auth/principal-resolver.ts` so the service can list safe
      active tenant choices for a Better Auth user and resolve the same user for one exact tenant ID.
      Include only active, non-revoked bindings joined to active Principals and active Tenants; return
      the tenant name for presentation and the tenant-scoped `principalId`/`displayName` only for the
      selected identity.
- [x] Keep tenant selection out of payload-derived trusted context: the requested tenant ID is a
      candidate that the resolver must match to the authenticated Better Auth user. A missing, foreign,
      revoked, disabled, suspended, or archived target fails closed without revealing whether another
      account can access it.
- [x] Define deterministic helpers: UI choices sort by tenant name and then tenant ID; initial or
      legacy selection uses the oldest eligible binding `createdAt` and then tenant ID. Once a session
      has a selected ID, never silently fall back to another tenant when that selection becomes invalid.
- [x] Adapt the typed errors and narrow Core exports in
      `principal-resolver-errors.ts`/`src/index.ts`; do not export repositories, Drizzle tables, or a
      generic tenant-membership service.
- [x] Update `packages/core-runtime/tests/unit/principal-resolver.test.ts` beside the refactor for
      zero, one, and multiple tenant bindings; ordering and default choice; exact selected resolution;
      duplicate/invalid record defense; inactive binding/Principal/Tenant filtering; foreign target
      denial; and database-unavailable typing.
- [x] Update `packages/core-runtime/tests/integration/principal-resolver.test.ts` with two active
      tenant-scoped Principals for one Better Auth subject. Prove both appear safely, either can be
      selected explicitly, cross-user/foreign IDs fail closed, and revocation or tenant suspension
      immediately removes access without tenant leakage.

### 3. Persist the selected tenant on the private Better Auth session

- [x] Add nullable `activeTenantId`/`active_tenant_id` to the `auth.session` Drizzle schema and to
      Better Auth's `session.additionalFields` configuration in `api/auth/service.ts`. Permit Better
      Auth's server-side `updateSession` operation to write it, while retaining the current architecture
      in which no raw Better Auth router or browser client is exposed.
- [x] Run `mise exec -- pnpm --filter @app/shell-super-app db:generate` from `app/` immediately after
      the schema change and commit only the generated Auth migration, snapshot, and journal updates.
      Do not hand-author or rename generated migration metadata.
- [x] Change the session-create hook to resolve eligible Core bindings and write the deterministic
      default tenant ID. Preserve sign-in failure semantics: no eligible tenant remains forbidden and a
      resolver/database outage remains retryable/unavailable.
- [x] For pre-migration sessions whose selected value is null, resolve the same deterministic
      default and persist it through Better Auth `updateSession` before returning an authenticated
      OntOS identity. Combine and forward all Better Auth `Set-Cookie` headers. Do not automatically
      replace a non-null selection that has become invalid.
- [x] Extend `AuthenticationServiceShape` with safe available-tenant and switch operations. Listing
      must return only `{ tenantId, name }`; switching must first resolve the exact target through Core,
      treat the current target idempotently, update only the current session, and return the selected
      tenant ID. Never return the Better Auth user ID, session ID/token, binding ID, credentials, or
      another tenant's Principal ID.
- [x] Add a typed forbidden-target error distinct from dependency unavailability and internal
      defects, and map Better Auth errors without leaking adapter, SQL, binding, or session details.
- [x] Extend `apps/shell-super-app/tests/unit/auth-schema.test.ts` to assert the exact typed nullable
      session column and retain the four-table Auth ownership contract.

### 4. Publish strict Effect tenant list and switch operations

- [x] Add `AvailableTenant`, available-tenant response, switch payload, and switch response Effect
      Schemas in `shared/api.ts`. Validate target tenant IDs with the repository UUID pattern
      (`Schema.String.check(Schema.isUUID())`), strip unknown response fields, and add stable contract
      paths for `GET /auth/tenants` and `POST /auth/tenant/switch`.
- [x] Declare operation-specific Problem Details: `401` plus `WWW-Authenticate` for no usable
      session, `403` for a target outside the authenticated user's active bindings, retryable `503` for
      required Auth/Core capability unavailability, and safe `500` for caught unexpected defects.
      Structural payload decoding remains the framework's `400` path.
- [x] Implement both handlers in `api/index.ts` as Effects over `AuthenticationService`. Exhaustively
      map every typed runtime error, forward refreshed/updated cookies, attach the authentication
      challenge only to `401`, and catch/log defects with correlation context before returning the
      declared safe `500`.
- [x] Add `availableTenants` and `switchTenant` to the generated client wrapper in
      `src/api/auth-client.ts`, retaining declared backend, HTTP transport, and Schema decode errors in
      precise operation-specific Effect unions. Do not add ad hoc `fetch` or a raw Better Auth client.
- [x] Extend `tests/unit/auth-contract.test.ts` to prove endpoint names, methods, exact paths,
      request/response decoding, UUID rejection, safe field stripping, declared statuses, and absence
      of passwords, session identifiers, tokens, binding IDs, and foreign Principal IDs.

### 5. Integrate independent tenant-list loading into authenticated Home

- [x] Extend `AuthenticatedHomePageModel` in `page.data.ts` with an independently recoverable tenant
      list state. Resolve the current session first; only for an authenticated identity, load active
      modules and available tenants through their generated client Effects without allowing one
      recoverable read failure to erase the other successful result.
- [x] Treat a tenant-list authentication failure after session resolution as anonymous/stale
      session. Map declared unavailable/internal/transport/decode failures to a tenant-list unavailable
      state that retains the trusted current identity and module result. Always keep a safe fallback
      item for the current tenant ID so the disabled Select still shows the context being retained.
- [x] Extend `tests/unit/routes/home/loader.test.ts` for anonymous isolation, two successful choices,
      deterministic order, independent module/tenant failures, current-tenant fallback, stale-session
      teardown, safe serialization, and forwarding the request cookie/base URL only through the
      generated client options.

### 6. Replace the empty placeholder with the controlled UI-kit Select

- [x] Refactor the existing Select in `shell-frame.tsx`; do not create a new component file. Extend
      the presentation contract with tenant choice view models, `currentTenantId`, availability,
      switch-pending/failure state, and semantic `onTenantChange(tenantId)` while keeping Effects,
      loaders, and page reload outside the layout.
- [x] Use the pinned `@techsio/ui-kit@0.25.1` Select with `items` containing `{ label, displayValue,
value }`, controlled array `value={[currentTenantId]}`, and the complete `Label`, `Control`,
      `Trigger`, `ValueText`, `Positioner`, `Content`, `Item`, `ItemText`, `ItemIndicator`, and
      `StatusText` anatomy. Use Select/Zag state and ARIA; do not add a native/custom select, manual
      keyboard handlers, invented props, or component-appearance `className` overrides.
- [x] Keep the prior tenant selected until a successful backend result. Dispatch only one new,
      non-empty value different from `currentTenantId`; disable selection while unavailable or pending
      and when no alternative tenant exists. Show localized pending/unavailable/error feedback through
      `Select.StatusText` with the correct `validateStatus` and live-region behavior.
- [x] Extend `tests/unit/layout.test.tsx` for current display name, ordered option labels/values,
      controlled array selection, complete item anatomy, disabled zero/one/unavailable states, enabled
      multi-tenant state, keyboard selection, ignored current/empty values, pending disablement,
      accessible error association, and unchanged navigation/account/page-child behavior.

### 7. Switch the session and reload all page data

- [x] In `page.tsx`, add one guarded tenant-switch handler beside logout. Run the contract-derived
      `switchTenant` Effect at the framework edge, clear the previous switch error, prevent duplicate
      invocation while pending, and pass only presentation state/callbacks into
      `AuthenticatedDashboardLayout`.
- [x] After success, call the browser's full document reload for the current localized URL. Do not
      patch only identity or active-module React state, invalidate only one query, navigate to a fixed
      route, or reuse data loaded under the old tenant.
- [x] On any typed backend, transport, or decode failure, clear pending state, retain the old
      identity/current tenant/modules/navigation, keep the Select operable, and show localized retryable
      feedback. If the session became anonymous, reload to the anonymous route state rather than retain
      stale authenticated chrome.
- [x] Extend `tests/unit/routes/home/page.test.tsx` to prove exact target dispatch, duplicate and
      same-value suppression, pending UI, no premature state replacement, full reload only after
      success, retained old context on failure, retry success, anonymous teardown, and no credential or
      session data exposure.

### 8. Localize and prove multi-tenant runtime behavior

- [x] Replace the placeholder-only `shell.dashboard.tenant` copy in both Shell locale files with
      aligned current selection, pending, unavailable, failure/retry, and accessible-label text. Reuse
      existing general dashboard/auth strings where their meaning is exact.
- [x] Extend `tests/unit/routes/login/locales.test.ts` for exact English/Czech tenant namespace
      parity and retain login, module, and dashboard locale contracts.
- [x] Expand `tests/integration/auth-runtime.test.ts` to create one Better Auth user with two active
      tenant-scoped Principals and distinct tenant module state. Prove deterministic initial selection,
      list redaction/order, successful and idempotent switch, persisted selection on a later session
      read, changed active-module scope, and a newly issued gateway assertion containing only the new
      tenant/principal context.
- [x] In the same integration suite, prove anonymous `401`, foreign/inactive target `403`, resolver
      and Auth persistence `503`, safe unexpected `500`, no session mutation on every failure, legacy
      null-session upgrade, and fail-closed behavior when the selected binding is revoked after switch.
- [x] Expand the E2E fixture to create two named tenants and two tenant-scoped Principals for one
      user with deterministic binding creation order. Clean up both tenants, bindings, Principals,
      module states, and Auth sessions without affecting unrelated data.
- [x] Extend `tests/e2e/login.spec.ts` to prove the initial tenant, keyboard and pointer selection,
      switch request success, full document navigation, changed rendered Principal/tenant context,
      persistence after another reload, and unchanged anonymous/login isolation in English and Czech.
- [x] Add browser failure/retry coverage that aborts one switch request and proves the old context
      and selected value remain visible and usable before retry. At 375px, prove the Select menu,
      feedback, Header, navigation, and page body remain reachable without horizontal overflow.
- [x] Run the UI-kit app adoption audit over the changed Shell files: verify the existing Select is
      used, every prop exists in `0.25.1`, no native/custom primitive or unnecessary wrapper was added,
      appearance remains token-first, and no UI-kit library or app-token override is required.

### 9. Run all validation commands

- [x] From `app/`, execute every command under Validation Commands in order, resolve every
      implementation-caused failure, then inspect `git diff --check`, the complete relevant diff, and
      final `git status --short`. Record any unrelated baseline failure accurately rather than claiming
      it passed.

## Testing Strategy

### Unit Tests

Use Core resolver tests for tenant-choice classification, deterministic defaulting, exact selected
resolution, and fail-closed invalid states. Use Shell contract/schema/loader/component tests for the
Auth session field, declared list/switch schemas and errors, independent UI data states, valid
UI-kit Select anatomy, controlled values, semantic callbacks, duplicate guards, reload behavior,
failure retention, and English/Czech parity.

### Integration Tests

Use the existing PostgreSQL-backed Core resolver and Shell Auth runtime suites with one Better Auth
user bound to two tenant-scoped Principals. Prove the selected ID is persisted on the Better Auth
session but always reauthorized through Core, and that active-module reads and gateway assertions
change tenant/principal only after a successful switch. Use Playwright for real cookie persistence,
full document reload, failure/retry, keyboard, localization, and responsive behavior.

### Edge Cases

- The user has zero, one, or multiple active tenant-scoped bindings.
- A legacy session has no `active_tenant_id` after migration.
- The selected binding, Principal, or Tenant becomes inactive after the session was created.
- A target tenant exists but is foreign to the authenticated Better Auth user.
- Tenant names are duplicated; ordering and values remain stable by tenant ID.
- The current tenant is selected again or repeated selection occurs while a switch is pending.
- Core tenant listing succeeds while active-module loading fails, or vice versa.
- Tenant listing, Better Auth session update, transport, response decoding, or document reload fails.
- Two browser tabs share one session and the latest completed session update becomes authoritative;
  either tab revalidates from the server on its next request/reload.
- A tenant name is long, the viewport is 375px wide, or the user operates the Select by keyboard.
- A response attempts to include credentials, session data, binding IDs, or another tenant's
  Principal details.

## Acceptance Criteria

- [x] One Better Auth user can have multiple active Core Principal Auth Bindings, one per tenant,
      without creating a global Principal or weakening tenant-scoped Principal identity.
- [x] A Better Auth session stores exactly one nullable active tenant ID; Core bindings remain the
      authority and every session resolution revalidates the selected binding, Principal, and Tenant.
- [x] New and legacy sessions choose the oldest eligible binding deterministically, while an
      invalid non-null selection fails closed rather than silently changing tenants.
- [x] The strict Shell Effect BFF exposes a safe available-tenant list and a typed switch operation;
      no raw Better Auth route/client, ad hoc fetch, Organization plugin, Auth vertical, or duplicated
      membership table is introduced.
- [x] Anonymous, forbidden target, unavailable dependency, malformed payload, and unexpected defect
      paths use correct declared HTTP semantics and safe Problem Details; `401` includes
      `WWW-Authenticate` and no error leaks tenant existence, SQL, bindings, sessions, or credentials.
- [x] The sidebar Select shows the current tenant and every active available tenant in deterministic
      order, uses tenant IDs as values and tenant names as display text, and never includes an inactive,
      revoked, disabled, suspended, archived, or foreign tenant.
- [x] The Select uses the pinned UI-kit compound API with an array value, complete item anatomy,
      keyboard/ARIA behavior, and `Select.StatusText`; no custom/native replacement, plain CSS,
      component appearance override, new UI component, or UI-kit library change is added.
- [x] The Select is disabled when choices are unavailable, a switch is pending, or no alternative
      exists; multi-tenant users can select by keyboard or pointer and duplicate invocation is guarded.
- [x] Successful switching updates only the current Better Auth session and triggers a full reload
      of the current localized page; the resulting identity, modules, navigation data, and future
      gateway assertions use the new tenant-scoped Principal context.
- [x] Failed switching never changes the persisted or displayed tenant context, retains all old
      page data, presents localized accessible feedback, and allows retry.
- [x] English and Czech copy remain structurally aligned; anonymous and login pages never expose the
      tenant switcher or authenticated dashboard chrome.
- [x] Unit, PostgreSQL integration, and browser tests cover initial selection, listing, success,
      persistence, full reload, idempotence, failure/retry, revocation, redaction, keyboard, and narrow
      viewport behavior.
- [x] The final implementation documents the approved exception for Better Auth session mechanics
      without weakening the Action requirement for canonical Core or MicroVertical business state.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime db:test` — run Core resolver unit and PostgreSQL
  integration coverage, including multi-tenant selection and fail-closed states.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run Auth schema/contract, loader,
  dashboard Select, switching, localization, and existing Shell unit coverage.
- `mise exec -- pnpm --filter @app/shell-super-app db:generate` — prove the committed Auth schema and
  generated migration snapshot are synchronized and produce no additional migration.
- `mise exec -- pnpm db:migrate` — apply Core and Shell Auth migrations, including
  `auth.session.active_tenant_id`.
- `mise exec -- pnpm db:verify` — verify the typed Core/Auth schema against PostgreSQL after migration.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — prove real Better Auth session
  creation, legacy upgrade, list/switch persistence, failures, module scope, and gateway context.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — prove localized browser selection,
  reload, persistence, failure/retry, keyboard, and responsive behavior.
- `mise exec -- pnpm i18n:boundaries` — validate Shell locale ownership and user-facing string rules.
- `mise exec -- pnpm api:check` — validate strict Effect BFF topology and server/browser boundaries.
- `mise exec -- pnpm contract:check` — validate route, topology, package, and ownership contracts.
- `mise exec -- pnpm typecheck` — type-check Core, Shell, the Better Auth additional session field,
  generated client operations, UI-kit props, and tests.
- `mise exec -- pnpm build` — build the Shell, Module Federation types, and runtime bundles affected
  by the new BFF and browser interaction.
- `git diff --check` — detect whitespace errors and conflict markers.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Implemented the complete tenant switcher and resolved the follow-up review findings: precise
  operation error unions, exhaustive client failure mapping before the Promise edge, shared resolver
  error translation, real resolver/Auth persistence failure handling, preservation of unexpected Auth
  update failures as correlation-logged defects, complete switch suppression and redaction tests,
  responsive failure feedback coverage, and removal of dead locale keys.
- Resolved the final repository-gate blockers: topology tests now derive installed verticals from the
  authoritative topology, the tracked agent-skills lock and license satisfy fresh-checkout validation,
  full-document tenant reload uses the router's native `reloadDocument` option, and generated topology
  validation includes the tenant list/switch operations.
- Confirmed all work ran in `/Users/jiprochazka/.codex/worktrees/b361/ontos`, the requested `b361`
  worktree at baseline `cc4fefea`.

### Changed Files

- Final task diff: 32 tracked files plus 5 new files, including the generated Auth migration,
  snapshot, tracked skills metadata, and this specification; 2,221 tracked insertions and 204 tracked
  deletions before this evidence update.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/principal-resolver.test.ts` — proves successful single-binding
  listing/default/selected resolution and timestamp-based binding revocation in addition to the
  zero/multiple and status-based invalid-state matrix.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — proves disabled zero-choice state plus ignored
  current and empty Select value events.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — proves real Core resolver and Better
  Auth persistence `503` paths, plus unexpected Better Auth persistence defects through the real switch
  and legacy-session upgrade paths; verifies correlation-aware `500` handling, response redaction, and
  unchanged persisted tenant context after every failure.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — proves exact/redacted dispatch,
  pending duplicate suppression, current-value suppression, typed failures, retry, and router-native
  full-document reload behavior.
- `apps/shell-super-app/tests/unit/auth-boundary.test.ts` — proves Shell topology vertical references
  and Module Federation remotes stay aligned without hardcoding a removed MicroVertical.
- `apps/shell-super-app/tests/unit/installed-verticals.test.ts` — proves the runtime derives the exact
  installed IDs injected from the authoritative reference topology without hardcoded registrations.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — proves failure feedback, tenant retention, Header,
  navigation, page body, menu, and overflow behavior at 375px.
- Existing tenant resolver, contract, schema, loader, Select, locale, integration, and E2E coverage
  remains part of the completed feature.

### Validation

- `mise exec -- pnpm --filter @app/core-runtime exec node --test tests/unit/principal-resolver.test.ts`
  — passed, 6/6.
- `mise exec -- pnpm --filter @app/shell-super-app exec rstest tests/unit/layout.test.tsx` — passed,
  9/9.
- `mise exec -- pnpm --filter @app/shell-super-app exec rstest tests/unit/layout.test.tsx tests/unit/routes/home/page.test.tsx tests/unit/routes/login/locales.test.ts` — passed, 25/25.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — passed, 2/2.
- `mise exec -- pnpm --filter @app/shell-super-app exec playwright test tests/e2e/login.spec.ts --grep "authenticated dashboard reachable"` — passed, 1/1.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — failed on the unrelated drifted default Core
  database and existing SpiceDB configuration; tenant-switcher-focused resolver tests passed during
  implementation against the dedicated validation database.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 63/63.
- `mise exec -- pnpm --filter @app/shell-super-app db:generate` — passed with no schema changes.
- `mise exec -- pnpm db:migrate` — blocked by the default database's legacy Core migration journal;
  the generated Auth migration previously applied successfully to the dedicated validation database.
- `mise exec -- pnpm db:verify` — failed on the unrelated drifted default
  `core.action_invocations` schema.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — passed, 10/10.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm skills:check` — passed using the tracked `.agents/skills-lock.json`; absent local
  skill bodies are an expected advisory in fresh check-only environments.
- `mise exec -- pnpm contract:check` — passed; the UltraModern workspace scaffold validated.
- `mise exec -- pnpm typecheck` — passed.
- `mise exec -- pnpm build` — passed after the router-native full-document navigation change,
  including Module Federation types and performance readiness.
- `git diff --check` — passed.
- `mise exec -- pnpm exec oxlint packages/core-runtime/tests/unit/principal-resolver.test.ts apps/shell-super-app/tests/unit/layout.test.tsx apps/shell-super-app/tests/integration/auth-runtime.test.ts`
  — passed.
- `mise exec -- pnpm exec oxfmt --check packages/core-runtime/tests/unit/principal-resolver.test.ts apps/shell-super-app/tests/unit/layout.test.tsx apps/shell-super-app/tests/integration/auth-runtime.test.ts`
  — passed.
- `mise exec -- pnpm lint` — previously passed for the complete implementation.
- `mise exec -- pnpm check` — passed end to end: formatting, lint, Action unit tests, typecheck,
  skills, i18n, API, contract, and performance readiness.

### Review

- Re-read and complied with both applicable `AGENTS.md` files plus `MICROVERTICALS.md`, `ACTIONS.md`,
  `ERRORS.md`, `DATABASE.md`, `OUTBOX_WORKERS.md`, `ULTRAMODERN.md`, `FRONTEND.md`, and the referenced
  product/ADR context.
- Resolved all three missing Spec test findings. No raw Better Auth route/client, ad hoc fetch, Action
  bypass, UI-kit replacement, plain CSS, new component, or unrelated API was added.
- Resolved the P1 Auth error-boundary finding: known session-update failures remain typed, while unknown
  rejections retain their private Effect cause until the switch/list/current-session HTTP boundary logs
  it with correlation context and returns the declared redacted `500`.
- Resolved all quality-gate drift without suppressions: replaced direct `window.location` use with the
  router's full-document primitive, synchronized the topology validation contract, and added the
  scaffold-pinned agent skills metadata under the supported tracked `.agents` layout.
- Browser validation passed the full localized pointer, keyboard, retry, reload, persistence, and
  responsive suite.

### Deviations and Follow-ups

- The latest re-review's P3 tenant-switcher prop data-clump remains a non-blocking design follow-up.
- The default local database still needs its pre-existing Core migration journal/schema drift repaired
  before repository-wide database migration, verification, and Core integration gates can pass there.

## Notes

- Source request: GitHub issue #78, `Implement the Tenant switcher`.
- Approval of this plan explicitly accepts issue #78 as superseding the older repository-level
  `Tenant-Scoped BetterAuth User`/no-selector product decision. Repository-level `../docs` are
  read-only under the current agent instruction and therefore remain historical context; the
  authoritative implementation clarification is recorded under `app/docs/architecture/`.
- The developer confirmed on 2026-08-06 that Better Auth credential/session lifecycle, including
  active tenant selection, is authentication mechanics analogous to existing sign-in/sign-out and
  is not an Action. Canonical Core and MicroVertical business state changes remain Action-driven.
- The selected tenant is session-scoped, not a cross-session user preference. A new session starts
  at the oldest still-eligible binding; switching persists across reloads for that session only.
- Concurrent switches from multiple tabs use session-level last-completed-write semantics. Every
  subsequent read revalidates the persisted selection through Core, and the UI prevents duplicate
  requests within one page instance.
- Better Auth `1.6.23` was verified to expose `session.additionalFields`, session-create database
  hooks, and server-side `auth.api.updateSession`. `@techsio/ui-kit@0.25.1` was verified to expose
  the planned controlled array value, `displayValue`, `onValueChange`, complete item anatomy,
  `validateStatus`, and `Select.StatusText` APIs.
- No mandatory Codesmith generator applies under the recommended design: no Action,
  MicroVertical page, Outbox Message, or Policy is created. The Auth migration must be generated by
  the existing Drizzle package script.
