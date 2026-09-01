---
type: feature
status: done
created: 2026-08-03
---

# Feature: Tenant MicroVertical state list

## Feature Description

Show the signed-in user's active MicroVerticals on the existing localized Shell home page. The
authenticated page must retain its current identity and logout UI and add only one semantic
`<ul>` whose items identify installed MicroVerticals with persisted state exactly `active` for
the tenant resolved from the authenticated principal.

Add a Core-owned, Effect-based read capability over `core.tenant_module_states` and expose that
read through the existing Shell strict Effect BFF and client. The browser or route loader must
never supply a tenant id, query Core tables directly, call a MicroVertical BFF for this list, or
model the read as an Action. The Shell must derive the tenant from the current Better Auth/Core
identity and intersect persisted active module keys with the authoritative generated topology so
stale or non-installed keys are not rendered.

Also make tenant MicroVertical state transitions safe and auditable. A Core-owned typed Action
must perform each transition inside the existing Action transaction and atomically update
`core.tenant_module_states` and insert the corresponding
`core.tenant_module_state_changes` history row. No state-changing UI is in scope.

## User Story

As a signed-in OntOS user
I want to see the MicroVerticals that are active for my tenant
So that the Shell reflects the modules currently available in my tenant context

## Problem Statement

The Shell currently resolves and displays a safe authenticated identity but does not load tenant
MicroVertical state. Although Core already owns the `tenant_module_states` current-state table and
the `tenant_module_state_changes` history table, it has no Effect service for listing active rows
or changing a state while enforcing the history invariant. The current Shell also knows that
`testing1` is installed through generated topology and Module Federation wiring, but its home
route does not combine that installed inventory with persisted tenant state.

Directly querying the database from the route, putting the read behind an Action, trusting a
client-supplied tenant id, or hardcoding `testing1` would break the Shell/Core boundary and would
not extend safely to later generated MicroVerticals. Updating only the current-state table would
also lose the required change history and actor/invocation evidence.

## Solution Statement

Introduce a narrow Core module-state capability with two separate paths:

- a read service lists rows whose `tenant_id` is the trusted tenant and whose state is exactly
  `active`, sorted deterministically by module key, without creating an Action invocation or a
  state-change history row;
- a generated Core-owned `core.modules.change-tenant-module-state` Action serializes transitions
  for one tenant, detects no-op transitions, and atomically writes both the current row and one
  history row carrying the previous state, new state, effective principal, Action invocation,
  source, reason, and timestamp.

Extend the existing Shell Effect API with an authenticated active-module read. Its handler
revalidates the current session, obtains the trusted tenant id, calls the Core read service, and
filters the result against installed vertical ids derived from
`topology/reference-topology.json`. Extend the existing generated-style Shell client and home
loader to preserve typed failures until they become an explicit page model.

For an authenticated page, render the resulting module key and active state in the new `<ul>`.
An empty result still renders an empty `<ul>`. A typed availability failure keeps the identity and
logout UI, renders an empty `<ul>`, and shows localized unavailable feedback associated with the
list. Anonymous users continue to see only the existing login link. Do not render remote widgets,
navigation, links, state controls, promotional content, or any other new UI.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits work to `app/` and requires Codesmith for every Action.
- `AGENTS.md` — defines the authoritative Shell/Core, Action, Effect, database, and frontend boundaries.
- `README.md` — documents the strict Effect BFF topology and repository-supported commands.
- `docs/architecture/MICROVERTICALS.md` — requires Shell/Core-governed MicroVertical entrypoints and strict vertical seams.
- `docs/architecture/ACTIONS.md` — requires every state change to run through a typed Action and commit its evidence atomically.
- `docs/architecture/ERRORS.md` — defines typed Effect failures and declared Problem Details mappings.
- `docs/architecture/DATABASE.md` — requires typed Drizzle queries inside Effect services and owner-local persistence.
- `docs/architecture/ULTRAMODERN.md` — requires generated business files and allows direct creation only for infrastructure files.
- `docs/frontend/FRONTEND.md` — defines loader, BFF client, UI-state, i18n, and accessibility rules.
- `../docs/CONTEXT.md` — assigns listing and changing tenant module states to the Core Modules Capability.
- `../docs/07_RUNTIME_CONSISTENCY_MODEL.md` — defines tenant module state history and actor/invocation invariants.
- `../docs/14_ONTOS_MODULE_MANIFEST.md` — provides the older installed-module and Shell visibility context.
- `../docs/adr/0008-module-activation-state-model.md` — defines persisted states and Shell/Core module-state enforcement.
- `packages/core-runtime/src/db/schema.ts` — owns `tenants`, `tenant_module_states`, `tenant_module_state_changes`, and Action evidence tables.
- `packages/core-runtime/src/db/client.ts` — owns the Effect-managed typed Core database service.
- `packages/core-runtime/src/db/types.ts` — defines the Core Drizzle executor and Action transaction surfaces.
- `packages/core-runtime/src/actions/context.ts` — must expose the current invocation id to a state-changing Action handler.
- `packages/core-runtime/src/actions/runtime.ts` — constructs the restricted handler context and owns the Action transaction.
- `packages/core-runtime/src/index.ts` — publishes the narrow Core module-state service and generated Core Action registration.
- `packages/core-runtime/package.json` — provides focused Core unit, integration, database, and typecheck commands.
- `packages/core-runtime/tests/unit/principal-resolver.test.ts` — shows focused Core Effect decision-test conventions.
- `packages/core-runtime/tests/integration/principal-resolver.test.ts` — shows tenant-isolated PostgreSQL fixture and cleanup conventions.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — proves Action transaction, idempotency, rollback, and evidence behavior.
- `apps/shell-super-app/api/index.ts` — existing Shell strict Effect BFF runtime and dependency-layer composition.
- `apps/shell-super-app/api/auth/service.ts` — authoritative current-session and trusted identity resolution.
- `apps/shell-super-app/api/auth/gateway-audiences.ts` — existing topology-derived installed vertical inventory to generalize rather than duplicate.
- `apps/shell-super-app/shared/api.ts` — existing Shell Effect API schemas and endpoint groups.
- `apps/shell-super-app/src/api/auth-client.ts` — existing contract-derived Shell client used by the home loader.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — server loader that must compose session and active-module Effects.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — authenticated home presentation where the sole requested UI addition is the `<ul>`.
- `apps/shell-super-app/locales/en/shell.json` — English list label, active-state label, and unavailable copy.
- `apps/shell-super-app/locales/cs/shell.json` — Czech equivalents for every added user-facing string.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — Shell API schema and operation-surface coverage.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — exact anonymous/authenticated page-content coverage.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — real session, Core database, and Shell BFF integration coverage.
- `apps/shell-super-app/modern.config.ts` — injects the authoritative generated topology into the Shell server build.
- `apps/shell-super-app/rstest.config.ts` — injects the same topology into Shell unit tests.
- `topology/reference-topology.json` — authoritative generated inventory containing the installed `testing1` vertical.
- `scripts/scaffolding/action/scaffold.mts` — current Codesmith Action generator, which supports only MicroVertical owners.
- `scripts/scaffolding/cli.mts` — current Action command contract and help text.
- `scripts/scaffolding/shared.mts` — current vertical-only Action scaffold configuration and owner discovery.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable fixture, preflight, composition, format, and compilation tests for generator changes.
- `scripts/check-ultramodern-api-boundaries.mts` — strict BFF and server/browser boundary validation.
- `scripts/validate-ultramodern-workspace.mts` — topology, ownership, API, and generated-workspace validation.

### New Files

- `packages/core-runtime/src/modules/tenant-module-state-errors.ts` — typed read and transition failure vocabulary.
- `packages/core-runtime/src/modules/tenant-module-state-service.ts` — Core Effect service for active-state reads and transactional state persistence.
- `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts` — Codesmith-generated Core-owned Action, adapted with the approved transition behavior.
- `packages/core-runtime/tests/unit/tenant-module-state.test.ts` — state classification, source mapping, no-op, and typed-failure tests.
- `packages/core-runtime/tests/integration/tenant-module-state.test.ts` — PostgreSQL-backed active-list and atomic state/history tests.
- `apps/shell-super-app/api/verticals/installed-verticals.ts` — generalized topology-derived installed vertical inventory shared by gateway issuance and the module list.
- `apps/shell-super-app/tests/unit/installed-verticals.test.ts` — topology decoding, duplicate/invalid id, and future-vertical coverage.

## Implementation Plan

### Phase 1: Foundation

Extend the existing Codesmith Action command with the approved Core-owned form before creating
the production Action. Preserve its current MicroVertical form, add strict Core owner/path
validation, and use the new form to create the initial
`core.modules.change-tenant-module-state` Action file. Establish shared module-state schemas,
typed failures, the invocation-id handler context, and the Core Effect service.

### Phase 2: Core Implementation

Implement the active-state query and the generated Core Action handler. Serialize state changes
per tenant, make first-time activation explicit with `previous_state = null`, reject no-op
transitions, and atomically insert history plus insert/update current state and `last_change_id`
inside the Action transaction. Add unit and PostgreSQL tests beside each behavior.

### Phase 3: Integration

Generalize the existing topology-derived installed vertical inventory, add the authenticated
Shell read contract/handler/client, and compose it in the home loader. Render only the requested
semantic list on the authenticated page, preserve every existing visible state outside that list,
and prove authentication, tenant isolation, installed-module filtering, typed failures, i18n,
accessibility, generator behavior, and full production build compatibility.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Extend and use the Core Action Codesmith generator

- [x] Update `AGENTS.md`, `scripts/scaffolding/cli.mts`, `scripts/scaffolding/shared.mts`, and `scripts/scaffolding/action/scaffold.mts` to add the approved `mise exec -- pnpm scaffold:action -- --scope core --module core.modules --action change-tenant-module-state` form. Keep the existing `--vertical <vertical> --action <action>` behavior unchanged; accept only stable `core.*` module keys, write only below `packages/core-runtime/src/modules/actions/`, and patch only an explicit generated Core Action export slot.
- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` before generating the production Action. Cover help text, mutually exclusive Core/vertical ownership, invalid owners, traversal, overwrite, no partial writes, deterministic exports, composition with every existing generator, formatter stability, and real-workspace compilation.
- [x] As the first business-artifact task after the generator extension exists, run `mise exec -- pnpm scaffold:action -- --scope core --module core.modules --action change-tenant-module-state` from `app/` to create `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts`; do not hand-create its initial file or wiring.
- [x] Confirm no Action, Action endpoint, state handler, or dependency is added to `verticals/testing1`; tenant module state remains owned by Shell/Core.

### 2. Add the Core tenant module state capability

- [x] Add one canonical readonly state vocabulary in the Core module-state infrastructure for `inactive`, `active`, `read_only`, `suspended`, `quarantined`, `deprecated`, and `archived`; reuse it in Effect Schemas and keep the existing Drizzle checks and migrations unchanged.
- [x] Implement typed errors for unavailable reads/persistence, missing tenant, unchanged state, unsupported change source, and any transition precondition that the Action can reject deliberately. Keep database causes and internal identifiers out of public messages.
- [x] Add `actionInvocationId` to `ActionHandlerContext` and populate it from the already locked invocation in `packages/core-runtime/src/actions/runtime.ts`; update Action runtime unit tests and disposable generated-output compilation tests so the context remains immutable, server-only, and invocation-scoped.
- [x] Implement `listActiveTenantModules(tenantId)` in `tenant-module-state-service.ts` with `CoreDatabase`, typed Drizzle columns, `state = 'active'`, deterministic `module_key` ordering, and a typed Effect error. It must return only module key plus the literal state required by the Shell and must not create an Action invocation, Audit Event, Data Access Event, or state-change history row.
- [x] Implement a transaction-only state persistence operation for the generated Action handler. Lock the owning tenant row, load the current tenant/module row, reject a same-state request, insert exactly one history row, then insert or update the current row with the returned history id and updated timestamp in the same Action transaction.
- [x] Set `previous_state = null` for the first persisted state, set `changed_by_principal_id` from the trusted effective principal, set `action_invocation_id` from the handler context, and derive `change_source` exhaustively from supported trusted auth methods (`session` to `user`, `support_impersonation` to `support`, and `system` to `system`). Reject unsupported sources rather than inventing a value.
- [x] Export only the typed state values, read service, failures, and generated Action registration from `packages/core-runtime/src/index.ts`; do not export private repository implementation or mutable database access.
- [x] Add focused unit tests for state schema decoding, source mapping, same-state rejection, safe errors, and the new handler context.

### 3. Implement and prove the Core state-changing Action

- [x] Adapt the generated `core.modules.change-tenant-module-state` descriptor with a payload containing `moduleKey`, `newState`, and an optional bounded reason; a typed result containing module key, previous state, and new state; required idempotency; a `sensitive` audit profile; metadata-only access evidence; and a declared domain-error union.
- [x] Keep tenant, principal, auth source, Action invocation id, correlation, and idempotency outside the business payload. The caller must provide trusted context and target metadata through `runAction`.
- [x] Call the Core module-state persistence operation only from the generated private handler and record the prior-state read through the Action collector when it contributes to the transition.
- [x] Add PostgreSQL integration tests proving first-time state creation, active-to-non-active and non-active-to-active transitions, exact previous/new values, one history row per commit, matching principal and invocation ids, current `last_change_id`, Action audit success, and no partial state/history/evidence after a typed rejection or forced persistence failure.
- [x] Prove repeated idempotent requests do not duplicate history, same-state requests write nothing, concurrent transitions serialize with truthful history order, and one tenant cannot read or change another tenant's row.
- [x] Do not add a generic Action HTTP endpoint or state-changing UI. A later administrator API may invoke this registration through its own declared BFF contract; direct database mutation remains forbidden application behavior.

### 4. Add the authenticated Shell/Core active-module read

- [x] Generalize `api/auth/gateway-audiences.ts` into `api/verticals/installed-verticals.ts` so both gateway audience issuance and module-list filtering use one Effect decoder over the topology injected by `modern.config.ts`; preserve exact app ids, reject malformed/duplicate vertical entries, and avoid raw import paths or browser-supplied module inventories.
- [x] Extend `apps/shell-super-app/shared/api.ts` with a Shell-owned `GET /modules/active` operation whose success schema is an ordered array of `{ moduleKey, state: 'active' }` and whose declared failures distinguish authentication required (`401` with Bearer challenge), temporary Core/database unavailability (`503`), and a sanitized unexpected failure (`500`).
- [x] Implement the handler in `apps/shell-super-app/api/index.ts`: revalidate the Better Auth session, forward any refreshed cookies, reject an anonymous or no-longer-valid session, take the tenant id only from the safe resolved identity, call the Core read service, intersect rows with installed vertical ids, sort by module key, and return no tenant/principal identifiers.
- [x] Extend the existing Shell client in `apps/shell-super-app/src/api/auth-client.ts` with the contract-derived active-module operation and its precise backend/transport/schema error union. Do not use ad hoc `fetch`, direct Core imports in route code, a MicroVertical client, or an Action.
- [x] Add Shell contract and handler unit tests for schema strictness, only-active results, declared Problem Details/statuses, Bearer challenge, unavailable/defect sanitization, installed-topology filtering, and absence of a client-supplied tenant field.

### 5. Render only the requested authenticated list

- [x] Replace the home loader's `CurrentSession` return with a serializable home-page model. Resolve the session first; for an authenticated session, call the active-module client with the incoming cookie and same-origin BFF base URL, preserve typed failures with Effect, and map them to `available` or `unavailable` list state without discarding the authenticated identity.
- [x] Keep anonymous behavior unchanged: do not request or render the module list, and continue to render exactly the existing localized login link.
- [x] In the existing authenticated section of `page.tsx`, add one semantic `<ul>` after the identity `<dl>` and before logout. Give it a localized accessible label and render one `<li>` per active installed module with its stable module key and localized active-state label.
- [x] For zero active modules, render the same empty `<ul>` without adding an empty-state card, call to action, navigation, remote widget, link, or control. For an unavailable read, keep the empty `<ul>` and add only localized, accessible unavailable feedback tied to this list; recovery is a route reload, because an additional retry control is outside the requested UI scope.
- [x] Preserve the current logout behavior. Successful logout must remove the identity and list together; failed logout must retain both. Do not change layout, spacing, colors, identity fields, button styling, responsive breakpoints, header, remote composition, or any other visible UI.
- [x] Update English and Czech locale files together and add component tests for anonymous absence, authenticated `<ul>` semantics, active item content/order, empty list, unavailable feedback, logout success/failure, and the absence of inactive, read-only, suspended, quarantined, deprecated, archived, foreign-tenant, and non-installed modules.

### 6. Add cross-boundary and future-MicroVertical regression coverage

- [x] Extend the Shell integration fixture with active and non-active state rows for the authenticated tenant, a foreign tenant, and a stale non-installed module key; call the real Shell BFF through a valid session and prove only installed `testing1` with exact state `active` is returned.
- [x] Prove anonymous, expired, forbidden, and database-unavailable requests return only their declared typed failures and never leak tenant ids, principal ids, SQL details, or topology internals.
- [x] Add a topology fixture containing a second generated MicroVertical and prove the installed inventory and Shell filtering include it without editing `installed-verticals.ts`, the page, or a hardcoded `testing1` registry.
- [x] Verify that the UltraModern quick-start-generated topology is the only new-MicroVertical registration needed for this read feature. Do not change `scaffold:microvertical-action-boundary`, `scaffold:microvertical-page`, or other Codesmith output unless a failing future-vertical regression test demonstrates required generated handling; if such handling is required, update its owning generator and disposable fixture before adapting generated application output.
- [x] Update workspace/API boundary validation only where needed to recognize the new Shell group and Core server-only exports while continuing to reject Core database code or state-changing handlers from browser bundles and MicroVertical exposes.

### 7. Run all validation commands

- [x] From `app/`, execute every command under Validation Commands in order and resolve every failure without modifying `mvp/`, `mvp2/`, or adding unrelated UI.
- [x] Inspect `git diff --check`, generated Action headers/export slots, the absence of schema/migration changes, topology usage, browser bundle boundaries, and final `git status`.

## Testing Strategy

### Unit Tests

Test the canonical state vocabulary, typed state/source errors, invocation-id handler context,
active-only Core query classification, generated Core Action descriptor, same-state rejection,
topology decoding, Shell API schemas and Problem Details, generated-style client error unions,
home loader mapping, semantic `<ul>` output, localization, exact active item order, empty/unavailable
states, and unchanged anonymous/logout behavior.

### Integration Tests

Run PostgreSQL-backed Core tests for initial state creation, serialized transitions, atomic current
state plus history, Action audit/evidence, idempotency, rollback, and tenant isolation. Run the real
Shell Effect BFF with Better Auth/Core fixtures to prove the session-derived tenant, active-only
query, installed-topology intersection, cookie propagation, declared failures, and response
redaction. Build the Shell and `testing1` to prove Core state infrastructure remains server-only
and does not cross the MicroVertical deployment seam.

### Edge Cases

- The authenticated tenant has no module-state rows or no rows with state exactly `active`.
- The database contains `active` rows for a module not present in generated topology.
- Another tenant has an active row for the same module key.
- The same module has each non-active state: `inactive`, `read_only`, `suspended`, `quarantined`, `deprecated`, or `archived`.
- A session expires or its principal/tenant becomes inactive between session and module-list reads.
- PostgreSQL or topology decoding is unavailable or malformed.
- The first state transition has no previous row.
- A requested state equals the current state.
- Two transitions for one tenant/module race, or the same idempotency key is retried.
- The effective actor is a session user, support impersonation, system principal, or unsupported API-key source.
- The state write succeeds locally but history, Action evidence, or transaction commit fails.
- A future quick-start MicroVertical is added without any page-specific or hardcoded registry edit.

## Acceptance Criteria

- [x] An anonymous home page remains unchanged and contains no MicroVertical list.
- [x] A signed-in home page renders a semantic `<ul>` while retaining the existing identity fields and logout button.
- [x] Each list item renders the installed MicroVertical module key and its active state; items are ordered deterministically.
- [x] Only rows for the trusted signed-in tenant with state exactly `active` and an installed topology entry are rendered.
- [x] Zero active modules renders an empty `<ul>`; a typed read failure preserves authenticated identity and exposes only localized list-unavailable feedback.
- [x] The route loads module state through the existing Shell strict Effect BFF and Core Effect service, not through an Action, direct database access, ad hoc fetch, or a MicroVertical BFF.
- [x] The module-list request accepts no tenant id from the browser and returns no tenant or principal identifiers.
- [x] Every committed state transition runs through the generated Core Action and atomically updates `core.tenant_module_states` plus inserts exactly one `core.tenant_module_state_changes` row.
- [x] Each history row contains the truthful previous/new state, effective principal, Action invocation id, change source, optional reason, and occurrence time; the current row references that change id.
- [x] First-time state creation records `previous_state = null`; no-op, rejected, failed, or idempotently replayed changes do not create duplicate history.
- [x] Tenant isolation and concurrent transition ordering are proven against PostgreSQL.
- [x] No state-changing control, navigation item, remote widget, link, card, layout/style change, or other unrelated UI is added.
- [x] A future generated MicroVertical becomes eligible for the list through authoritative topology plus persisted active state, without hardcoded page or registry edits.
- [x] No application schema or migration change is introduced because the existing Core tables support the feature.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — strictly typecheck the approved Core Action generator extension and disposable fixtures.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — lint Codesmith infrastructure outside the normal application lint roots.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — run all generator behavior, failure, composition, format, and generated-output compilation tests.
- `mise exec -- pnpm scaffold:action -- --help` — verify both existing MicroVertical and approved Core Action command forms are documented without writing files.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — run Core unit and PostgreSQL integration tests for reads, Actions, atomic history, rollback, concurrency, and isolation.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — typecheck the Core service, generated Action, handler context, and tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run Shell contract, topology, loader, page, i18n, and unchanged auth/logout unit tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — run the real session-to-tenant-to-active-module BFF flow and declared failure cases.
- `mise exec -- pnpm api:check` — validate strict Effect API topology and server/browser import boundaries.
- `mise exec -- pnpm contract:check` — validate topology, ownership, generated workspace metadata, and published surfaces.
- `mise exec -- pnpm build` — build `testing1` and the Shell with production BFF and Module Federation boundaries.
- `git diff --check` — detect whitespace errors and conflict markers.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- `tenant_module_state_changesonly` in the request is treated as a typographical joining of
  `tenant_module_state_changes` and “only.” The existing canonical table is
  `core.tenant_module_state_changes`; this feature does not add or rename a table.
- “load the list of active tenants” is interpreted as “load active MicroVerticals for the tenant
  resolved from the signed-in user.” The request's preceding and following bullets consistently
  describe MicroVertical state, and the product model gives one tenant to the current authenticated
  principal.
- The list is intentionally stricter than the older normal-navigation rule in
  `../docs/14_ONTOS_MODULE_MANIFEST.md`: this requested home-page list includes only exact `active`
  rows, not `read_only` or `deprecated`. It is not a navigation implementation.
- The generated topology app id `testing1` is the persisted module key for this proof. Display
  names and an OntOS Module Manifest are not yet implemented, so the list renders the stable key
  rather than inventing metadata.
- No seed data is added. The page reflects persisted Core state; integration tests create isolated
  fixtures and clean them up in foreign-key order.
- The state-changing Action is server-side only in this scope. No generic Action endpoint or
  administrator UI is added.
- The current Codesmith Action command discovers only `verticals/*`. The developer approved
  extending it with `scaffold:action -- --scope core --module core.modules --action ...` on
  2026-08-03. The implementation must add and test that generator form before it creates the Core
  Action; creating the Action manually remains forbidden.
- No unresolved developer decision blocks implementation.

## Implementation Evidence

### Summary

- Extended the mandatory Codesmith Action generator with the mutually exclusive Core ownership
  form and used it to generate `core.modules.change-tenant-module-state` before adapting the
  generated Action.
- Added the Core active-module read service and the transaction-only, idempotent, auditable state
  transition path without changing the existing schema or migrations.
- Added the authenticated Shell Effect BFF operation, topology intersection, contract-derived
  client, serializable loader model, and the single localized semantic list requested by this
  feature.

### Changed Areas

- `scripts/scaffolding/` and `AGENTS.md` for the tested Core Action generator contract.
- `packages/core-runtime/src/modules/` and focused Core unit/integration tests for state reads and
  transitions.
- `apps/shell-super-app/` for topology inventory, the strict Effect BFF/client/loader path,
  localized presentation, and focused unit/integration coverage.
- No files under `verticals/testing1`, `packages/core-runtime/src/db`, `mvp/`, or `mvp2/` were
  changed. No database schema or migration was added.

### Validation Results

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — 20/20 passed.
- `mise exec -- pnpm scaffold:action -- --help` — passed and documents both ownership forms.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — 89/89 passed with the repository's
  PostgreSQL fixture and a disposable SpiceDB instance using the tracked development key.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — 44/44 passed.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — 1/1 passed with the real
  Better Auth session, Core PostgreSQL state, and Shell BFF flow.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm contract:check` — passed.
- `mise exec -- pnpm build` — the complete testing1 and Shell client/server production build,
  type generation, deployment output, and performance checks passed.
- `git diff --check` — passed.
- `mise exec -- pnpm check` — passed, including formatting, lint, 48 Action tests, root typecheck,
  skills, i18n, API, contract, and performance checks.

### Review Results

- Final review found no unresolved correctness, boundary, accessibility, localization, security,
  or generated-code issues.
- The generated Action header identifies owner `core.modules`, and its registration is wired only
  through the explicit generated Core Action export slot.
- Final scope and status inspection confirmed the requested branch remains on its original single
  commit; implementation changes are intentionally uncommitted.

### Validation Deviations

- An already-running local SpiceDB container used credentials that did not match the repository's
  tracked test configuration. Final Core database validation used a disposable repository-configured
  SpiceDB container on an alternate port; it was stopped and removed afterward.
- The release-envelope build correctly refuses a dirty Git worktree. To validate the exact current
  uncommitted content without changing the requested branch or history, the final production build
  used disposable Git metadata in `/tmp`; that metadata was deleted after the successful build.
- Browser review confirmed the anonymous page still renders only the login link and no list. An
  authenticated follow-up navigation was blocked by the local-browser URL policy; the attempted
  review nevertheless exposed and led to a fix for strict Effect runtime topology injection.
  Authenticated, empty, unavailable, ordering, logout, and redaction behavior is covered by the
  passing component, loader, BFF unit, and real Shell integration tests. The anonymous proof is
  retained at `.codex/reports/review/feature-tenant-microvertical-state-list/anonymous-home.png`.
