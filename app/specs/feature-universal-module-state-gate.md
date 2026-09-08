---
type: feature
status: done
created: 2026-08-06
---

# Feature: Universal Module State Gate

## Feature Description

Make tenant module state a universal Core invariant for every OntOS Business Module entrypoint.
Core must decide whether a structured entrypoint is loadable or dispatchable before permission
checks, Policy evaluation, private handler resolution, Module Federation loading, or module code
execution. The same closed state/access matrix must govern Actions, pages, public components,
module APIs, search, reports, and Outbox Workers.

Implement the reusable Core gate and gateway contracts now, integrate them with the Action and
Outbox Worker runtimes that exist on `develop`, and establish fail-closed descriptors, Codesmith
output, repository checks, and application guidance for categories that do not yet have business
implementations. Future entrypoint code must be unable to pass the normal `pnpm check` gate unless
it declares a structured entrypoint and uses an approved Shell/Core gateway. The gateway must
batch state reads and reuse one immutable request-scoped snapshot so composing many entrypoints
does not create one database query per page, component, search provider, or report.

## User Story

As a tenant administrator and OntOS operator
I want every module capability to respect the tenant's current module state
So that inactive, read-only, suspended, quarantined, deprecated, or archived modules cannot be
loaded or executed through an overlooked entrypoint

## Problem Statement

`develop` persists all seven tenant module states, exposes Core reads and a Core-owned state-change
Action, filters the current Shell list to installed active modules, and restricts Outbox Worker
claims to consuming modules whose state is `active`. These are isolated behaviors rather than one
Core invariant.

The Action runtime demonstrates the gap. `runAction` decodes the payload, retrieves the private
handler, validates trusted context, creates or resolves an invocation, checks SpiceDB permission,
evaluates Policies, and executes the handler without checking the owning module's tenant state.
The current generated Action and Outbox Worker descriptors carry owner keys but no common
structured entrypoint or access requirement. Generated MicroVertical pages carry `ownerAppId` in
route metadata but no governed load requirement. No equivalent registration or enforcement
contract exists yet for module APIs, public components, search, or reports.

This permits present and future bypasses: an inactive module Action can execute, a direct route or
remote load can avoid Shell filtering, and new API/search/report/component implementations could
invent local state checks or omit them entirely. A reusable `isActive` helper would still be
optional and would allow the seven-state semantics to drift between runtimes. Likewise, a gateway
that performs one exact database lookup per entrypoint would turn a composed Shell page into an
N+1 query path and make universal enforcement unnecessarily expensive.

## Solution Statement

Introduce a narrow Core-owned structured entrypoint contract, one closed state/access decision
matrix, a typed `ModuleStateGate` Effect service, and a `ModuleEntrypointGateway` that accepts
trusted tenant context plus lazy authorization/load/dispatch Effects. The gateway must evaluate
state before invoking downstream authorization or the lazy module implementation. Core system
capabilities use an explicit system-entrypoint classification and bypass tenant activation only;
they still pass through authentication, SpiceDB authorization, Policy, evidence, and other
applicable controls. Never infer the bypass from an arbitrary string prefix at the call site.

Use these access classes:

| Tenant state  | `read` | `historical_read` | `write` | `background` |
| ------------- | -----: | ----------------: | ------: | -----------: |
| `active`      |  allow |             allow |   allow |        allow |
| `read_only`   |  allow |             allow |    deny |         deny |
| `deprecated`  |  allow |             allow |    deny |         deny |
| `inactive`    |   deny |             allow |    deny |         deny |
| `suspended`   |   deny |             allow |    deny |         deny |
| `quarantined` |   deny |              deny |    deny |         deny |
| `archived`    |   deny |             allow |    deny |         deny |
| missing row   |   deny |              deny |    deny |         deny |

`historical_read` is an explicit entrypoint classification, never a fallback from a denied normal
read. It exists for permission-checked historical/audit/reporting paths and must not put inactive,
suspended, or archived modules into ordinary navigation. Quarantine denies every module-owned
entrypoint because its purpose includes defect, migration, and data-safety containment.

Map entrypoint categories to access deliberately: Actions are `write`; Workers are `background`;
pages, public components, and search default to `read`; every API and report declares `read`,
`historical_read`, or `write` explicitly. An API write remains only a transport edge into an
Action—it does not gain an independent write handler.

Separate state acquisition from state evaluation. At the start of one trusted Shell, SSR, route,
or BFF request, collect the distinct tenant-scoped module keys from the structured entrypoint set,
load them in one indexed batch query, decode them once, and build an immutable request-scoped
snapshot. Every gateway decision in that request is then a pure in-memory matrix evaluation.
Repeated checks for the same module do not query again. A tenant entrypoint absent from the
declared snapshot fails closed rather than issuing an implicit per-entrypoint query; the owning
composition boundary must declare the complete batch. Empty and system-only batches perform no
state query.

Use this database-query budget:

| Runtime composition                                                           | Module-state database work                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| One Shell/SSR/page composition with any number of declared module entrypoints | At most one batch query for all distinct tenant module keys                |
| Repeated gateway decisions from the same request snapshot                     | Zero additional queries                                                    |
| Explicit Core system entrypoints                                              | Zero tenant-module-state queries                                           |
| One independently deployed BFF request                                        | At most one batch query for that request's declared entrypoints            |
| One business Action attempt                                                   | One early indexed read plus one authoritative transactional recheck        |
| One Outbox Worker claim cycle                                                 | Zero additional queries beyond the existing transactional claim query/join |

Keep the snapshot request-scoped. Do not introduce a process-global, TTL, browser-authoritative,
or distributed cache in this increment: activation changes must affect the next independent
request without restart or invalidation coordination. A page-load decision never replaces the
independent BFF/Action check at the next trust boundary. Instrument gate acquisition/evaluation
with safe Effect telemetry for batch size, acquisition latency, snapshot reuse, scope/access, and
outcome, without arbitrary payloads or credentials.

Integrate Actions after structural payload and trusted-context validation but before invocation
creation, permission, Policy, or handler resolution. A module-state denial creates no Action
Invocation Log because the request never enters the module Action lifecycle. Recheck a business
module's `write` access with the Core transaction immediately before handler execution so a state
transition between the early gate and dispatch cannot authorize a stale write. A failed locked
recheck rolls back the business attempt and follows the existing open-invocation retry semantics.
The `core.modules.change-tenant-module-state` system Action must remain usable for recovery even
when the target business module is not active.

Refactor Outbox Worker eligibility to use the same `background` semantics while preserving its
transactional claim query, tenant isolation, leases, and no-attempt behavior for ineligible work.
The consuming module—not the producer—governs dispatch. Handler resolution remains after a
successful eligible claim.

Add a dedicated repository boundary check to the root quality gate. It must validate generated
Action/page/Worker entrypoint metadata, approved gateway composition, lazy loads, owner/role/access
consistency, and forbidden direct private imports or raw `loadRemote(...)` calls. It must also
reserve fail-closed registration slots for API, public-component, search, and report entrypoints:
until a category has an approved generator and gateway adapter, introducing that category must
fail validation with an instruction to extend Codesmith and the gateway first.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits work to `app/` and makes Codesmith mandatory for supported business artifacts.
- `AGENTS.md` — authoritative application rules; must make governed module entrypoints a non-negotiable rule and reference the detailed architecture document.
- `README.md` — documents the workspace, strict Effect topology, scripts, and generated vertical conventions.
- `docs/architecture/MICROVERTICALS.md` — defines strict deployment seams, Shell/Core governance, and private implementation boundaries.
- `docs/architecture/ACTIONS.md` — owns the Action lifecycle whose ordering must include the state gate and transactional recheck.
- `docs/architecture/OUTBOX_WORKERS.md` — requires active-state consumer dispatch and no attempts for ineligible deliveries.
- `docs/architecture/ERRORS.md` — requires typed transport-neutral Core failures and exhaustive public mappings.
- `docs/architecture/ULTRAMODERN.md` — requires generators for business artifacts and permits direct files only for infrastructure/architecture work.
- `docs/frontend/FRONTEND.md` — governs route/feature loading, typed BFF failures, and unavailable UI states.
- `../docs/05_MICROVERTICALS.md` — defines the seven states, visible normal states, and explicit historical access.
- `../docs/06_CORE_KERNEL.md` — requires every module entrypoint to pass through Shell/Core before loading or dispatch.
- `../docs/CONTEXT.md` — defines Module State Gate, Structured Entrypoint, Core Modules Capability, and Vertical Runtime Registration.
- `../docs/14_ONTOS_MODULE_MANIFEST.md` — describes the intended public manifest/private runtime-registration separation without making the full manifest a prerequisite here.
- `../docs/15_PRE_DEVELOPMENT_VALIDATION_REPORT.md` — identifies the currently unresolved state-by-surface matrix.
- `../docs/adr/0008-module-activation-state-model.md` — forbids direct entrypoint loading and requires structured Shell/Core gateways.
- `packages/core-runtime/src/modules/tenant-module-state-service.ts` — owns the canonical state vocabulary and persisted tenant-state reads.
- `packages/core-runtime/src/modules/tenant-module-state-errors.ts` — existing typed module-state failures to keep separate from gate decisions.
- `packages/core-runtime/src/actions/definition.ts` — Action descriptor/handler registration and private handler accessor.
- `packages/core-runtime/src/actions/runtime.ts` — Action ordering, dependencies, handler resolution, transaction, and runtime stages.
- `packages/core-runtime/src/actions/errors.ts` — closed transport-neutral Action error union and tags.
- `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts` — Core recovery Action that needs explicit system-entrypoint classification.
- `packages/core-runtime/src/outbox/definition.ts` — Worker descriptor/handler registration and private handler accessor.
- `packages/core-runtime/src/outbox/repository.ts` — transactional eligible-delivery selection and active consumer-state join.
- `packages/core-runtime/src/outbox/runtime.ts` — Worker validation, claim, handler resolution, execution, and finalization ordering.
- `packages/core-runtime/src/outbox/errors.ts` — typed Worker failure vocabulary.
- `packages/core-runtime/src/index.ts` — approved public Core contracts; private accessors and persistence internals must remain unexported.
- `packages/core-runtime/package.json` — focused Core Action, Worker, database, and typecheck scripts.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — Action order, dependency, denial, and handler non-execution tests.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — PostgreSQL Action transaction, concurrency, and retry behavior.
- `packages/core-runtime/tests/integration/tenant-module-state.test.ts` — Core module-state and recovery-Action behavior.
- `packages/core-runtime/tests/unit/outbox-runtime.test.ts` — Worker validation, dispatch, and handler behavior.
- `packages/core-runtime/tests/integration/outbox-runtime.test.ts` — persisted per-state Worker eligibility and no-attempt behavior.
- `apps/shell-super-app/api/index.ts` — Shell strict Effect BFF composition where a trusted request-scoped batch/snapshot layer may be provided without making the browser authoritative.
- `apps/shell-super-app/api/verticals/installed-verticals.ts` — authoritative topology-derived installed business-module inventory used by Shell gateway decisions.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — existing Shell request-loader boundary and reference point for request-scoped state acquisition rather than per-component calls.
- `apps/shell-super-app/src/routes/vertical-components.tsx` — generated Shell browser composition surface where future remote loads must be lazy and gateway-owned.
- `apps/shell-super-app/src/routes/vertical-components.worker.tsx` — Worker SSR composition surface that must not bypass the same structured load contract.
- `scripts/scaffolding/action/scaffold.mts` — must emit tenant `write` entrypoints and explicit Core system entrypoints.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — must emit governed `read` route metadata rather than an owner id alone.
- `scripts/scaffolding/outbox-worker/scaffold.mts` — must emit structured `background` descriptors and consistent generated catalogs/registries.
- `scripts/scaffolding/cli.mts` — generator help must explain gateway-owned output and future preparation commands if one-time wiring is required.
- `scripts/scaffolding/shared.mts` — shared owner discovery, markers, generated slots, and mutation safety.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable fixture tests for all updated generated outputs and fail-closed composition.
- `scripts/generate-tanstack-routes.mts` — must preserve and validate structured route-entrypoint metadata in generated route manifests.
- `scripts/check-ultramodern-api-boundaries.mts` — must require approved module API gateway integration for future vertical APIs.
- `scripts/validate-ultramodern-workspace.mts` — existing topology, Module Federation, route, Worker catalog, and direct-remote-import checks to reuse rather than duplicate.
- `package.json` — must expose the dedicated boundary command and include it in `pnpm check`.

### New Files

- `docs/architecture/MODULE_ENTRYPOINTS.md` — authoritative state/access matrix, entrypoint categories, lifecycle order, system exception, historical access, and bypass rules.
- `packages/core-runtime/src/modules/module-entrypoint.ts` — Effect Schema-backed structured entrypoint role/access/scope definitions and safe constructors.
- `packages/core-runtime/src/modules/module-state-gate-errors.ts` — closed sanitized gate denial and unavailable-check failures.
- `packages/core-runtime/src/modules/module-state-gate.ts` — pure matrix evaluation plus live and transaction-aware Effect gate service.
- `packages/core-runtime/src/modules/module-entrypoint-gateway.ts` — reusable gated authorization/lazy-dispatch coordinator that never accepts an eagerly resolved private implementation.
- `packages/core-runtime/tests/unit/module-state-gate.test.ts` — exhaustive matrix, descriptor, system exception, ordering, laziness, and safe-error tests.
- `packages/core-runtime/tests/integration/module-state-gate.test.ts` — PostgreSQL tenant isolation, missing-state, unavailable-state, and transaction-aware recheck tests.
- `scripts/check-module-entrypoint-boundaries.mts` — dedicated fail-closed workspace check for structured registration, generated metadata, approved gateways, and bypass imports.
- `scripts/tests/module-entrypoint-boundaries.test.mts` — disposable workspace fixtures proving every accepted and rejected category.

## Implementation Plan

### Phase 1: Foundation

Update the existing Codesmith templates and fixture expectations first so no new generated Action,
page, or Worker can be produced with the old bypassable shape. Define the architecture document,
the closed entrypoint role/access vocabulary, the approved state matrix, explicit system scope,
typed failures, batched state acquisition, immutable request-scoped snapshots, and the Core
gate/gateway services. Add exhaustive unit, query-budget, and PostgreSQL integration tests beside
the foundation.

### Phase 2: Core Implementation

Wire the gate into the existing Action and Outbox Worker runtimes. Preserve each specialized
lifecycle: Actions gate before invocation/authz/Policy/handler access and recheck under the
business transaction; Workers retain atomic claim eligibility and use the shared background
decision. Update descriptors, layers, public errors, runtime stages, test harnesses, and existing
integration fixtures without weakening idempotency, evidence, leases, or deployment seams.

### Phase 3: Integration

Add repository enforcement and future-category rails. Preserve structured page metadata through
route generation; require future vertical APIs to use the approved gateway adapter; require public
component, search, and report registrations to declare an entrypoint before they can be exported
or discovered; and reject raw remote/private implementation loading. Update `AGENTS.md` and every
affected architecture document so implementation agents are required to use the gateway and to
extend Codesmith before introducing a category the repository cannot yet scaffold safely. Make
batch acquisition and request-scoped snapshot reuse part of the same mandatory contract so future
composition code cannot replace security bypasses with N+1 state queries.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Update Codesmith entrypoint output before changing runtime contracts

- [x] Extend shared scaffold markers/types and `scripts/scaffolding/action/scaffold.mts` so every generated MicroVertical Action declares one tenant-scoped `action`/`write` entrypoint whose module key matches `owningModuleKey`; every generated Core Action declares an explicit system-scoped entrypoint. Do not infer system scope from a caller-provided prefix at runtime.
- [x] Update `scripts/scaffolding/microvertical-page/scaffold.mts` so generated route metadata contains a structured tenant `page`/`read` entrypoint tied to the discovered topology app id. Preserve private-first route metadata, locales, route refresh, safe reruns, and no-partial-write behavior.
- [x] Update `scripts/scaffolding/outbox-worker/scaffold.mts` and its schema-free subscription catalog/owner registry output so every generated Worker carries one tenant `worker`/`background` entrypoint whose module key is exactly `consumerModuleKey`.
- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` before adapting production descriptors. Prove correct tenant/system output, owner-role-access mismatch rejection, stale generated slots/catalog rejection, idempotent reruns, formatter stability, compilation, and composition of Action, page, Worker, Outbox Message, Policy, and action-boundary generators.
- [x] Keep Outbox Message and Policy generators unchanged unless compilation proves they must consume the shared descriptor types; neither artifact is itself a module entrypoint.

### 2. Document the mandatory universal gateway contract

- [x] Add `docs/architecture/MODULE_ENTRYPOINTS.md` with the exact matrix in this plan, the seven categories, access classification rules, trusted tenant requirement, historical-path rules, explicit Core system exception, fail-closed missing/unavailable behavior, early check plus write recheck, and prohibition on eager handler/remote loading.
- [x] Document the performance contract in the same file: one predeclared distinct module-key batch, one immutable request-scoped snapshot, pure in-memory decisions after acquisition, no implicit lookup for a key absent from the snapshot, the query-budget table in this plan, no cross-request cache, and an independent check at each new BFF/Action trust boundary.
- [x] Update `AGENTS.md` to list Module Entrypoints as a non-negotiable architecture rule and link the new document. State that Actions, pages, APIs, public components, search, reports, and Workers must use approved generated descriptors and Shell/Core gateways; when a future category lacks a generator or adapter, implementation must stop and extend/approve Codesmith first.
- [x] Update `docs/architecture/MICROVERTICALS.md`, `ACTIONS.md`, `OUTBOX_WORKERS.md`, `ERRORS.md`, `ULTRAMODERN.md`, and `docs/frontend/FRONTEND.md` so their lifecycle diagrams, typed-error requirements, generator rules, direct-import rules, and frontend unavailable states agree with the new document rather than duplicating divergent matrices.
- [x] Explicitly record that normal navigation visibility and historical entrypoint access are different decisions. This feature must not silently widen the existing Shell `activeModules` UI contract; a later navigation feature may expose `read_only` and `deprecated` with state indicators using the same matrix.

### 3. Add structured entrypoints and the central Core decision service

- [x] Add Effect Schema-backed closed values for roles `action`, `page`, `public_component`, `api`, `search`, `report`, and `worker`; access classes `read`, `historical_read`, `write`, and `background`; and explicit tenant/system scope. Validate stable entrypoint keys and module keys and freeze every accepted descriptor.
- [x] Provide safe descriptor constructors that enforce valid role/access combinations: Action/write and Worker/background are fixed; page/public-component/search are read or explicitly historical; API/report must declare one supported access; system descriptors cannot be created through the tenant constructor.
- [x] Add a pure exhaustive decision function over every persisted state plus missing state. Encode the matrix once and use it from all runtime adapters and tests; do not scatter state arrays or `state === 'active'` checks across callers.
- [x] Extend `TenantModuleStateService` with one batch read accepting a trusted tenant id and a prevalidated readonly set of installed module keys. Deduplicate and deterministically order keys, perform one indexed `tenant_id` plus `module_key IN (...)` query, decode each returned state once, represent omitted rows as missing, return an immutable result, return an empty result without querying for an empty/system-only batch, and sanitize database/decoding failures.
- [x] Build an immutable request-scoped module-state snapshot from the batch result and declared descriptors. The snapshot records the exact tenant and module-key set it covers, cannot be extended from client input, reuses decoded values for repeated decisions, and fails closed when asked for an undeclared tenant key instead of issuing an implicit lookup.
- [x] Implement `ModuleStateGate` with snapshot-backed normal checks and a separate transaction-aware authoritative check for write revalidation. Explicit system entrypoints bypass only tenant-state acquisition; keep the database/repository implementation private and expose only typed Effect operations.
- [x] Implement `ModuleEntrypointGateway` so it receives trusted context, a prepared request snapshot, a structured descriptor, deferred authorization, and deferred implementation load/dispatch Effects. Prove with spies that denial/unavailability never evaluates authorization, Policy callbacks, imports, handler accessors, or execution and that repeated allowed/denied checks do not call the batch reader again.
- [x] Add sanitized typed failures that distinguish a definite state denial from an indeterminate/unavailable state read without exposing database causes, arbitrary payloads, credentials, or private implementation identifiers. Keep Core transport-neutral; document `403` as the default declared public denial and retryable `503` for gate unavailability unless an endpoint has a more precise approved semantic mapping.
- [x] Add safe Effect telemetry around batch acquisition and decision evaluation. Record batch size, elapsed acquisition time, request-snapshot hit/reuse, system-versus-tenant scope, access class, and allow/deny/unavailable outcome; do not record arbitrary payloads, credentials, raw database errors, or browser-supplied tenant data.
- [x] Export only descriptors, constructors, the service/gateway interfaces and live layers, and typed failures from `packages/core-runtime/src/index.ts`. Do not export gate repositories, private handler accessors, raw database executors, or a boolean bypass helper.
- [x] Add exhaustive unit tests for all state/access cells, missing rows, system scope, invalid descriptors, stable/frozen values, safe errors, lazy ordering, module-key deduplication, empty/system-only batches, undeclared snapshot keys, and telemetry safety. Use a counting fake repository to prove one batch read for many descriptors and zero additional reads for repeated snapshot decisions. Add PostgreSQL integration tests for tenant isolation, multi-key batches, each persisted state, malformed stored state, unavailable reads, and transaction-aware checks.

### 4. Make the Action runtime state-gated

- [x] Add the structured entrypoint requirement to `ActionDescriptor` and validate that role is `action`, access is `write`, and the entrypoint module key matches `owningModuleKey`. Update definition/public-surface tests and all hand-built unit/integration registrations.
- [x] Adapt the existing generated `core.modules.change-tenant-module-state` Action to the explicit system descriptor so administrators cannot be locked out of state recovery. Its target module remains payload/target data and must never become the owning entrypoint identity.
- [x] Inject the Core gateway/gate into `makeActionRuntime` and `ActionRuntimeLive` without exposing private dependencies. Update all fakeable test harnesses and preserve the shared Core database layer.
- [x] Move `getActionHandler` out of the pre-context path. After payload and trusted principal/transport validation, gate the owning module before request hashing, invocation creation, SpiceDB, or Policy. Resolve the private handler only after gate, permission, and every Policy allow.
- [x] Add explicit runtime stages for the early module-state gate and locked recheck. Update `docs/architecture/ACTIONS.md` and stage-order tests to prove module state precedes invocation/permission/Policy and handler resolution.
- [x] Recheck tenant `write` access inside the Core-owned business transaction immediately after locking/verifying the invocation and before creating the collector or resolving/executing the handler. Coordinate with the state-change Action's tenant lock so a concurrent suspension cannot produce a stale authorized write.
- [x] Add the gate's definite denial and unavailable-check failures to the closed `ActionCoreError` union/tags and update error/public-surface tests. A pre-invocation denial writes no invocation or Action evidence; a locked recheck failure rolls back and leaves the existing invocation open under current retry semantics.
- [x] Add unit tests proving denied/missing/read-only/deprecated/suspended/quarantined/archived states never call permission, Policy, repository invocation creation, handler accessor, or handler; unavailable checks fail closed; active runs preserve the existing lifecycle; and Core system Actions still run through permission and Policy. Count state-repository calls: one early read for a business Action, zero for a system Action, and no accidental per-stage requery.
- [x] Add PostgreSQL integration tests for all states, tenant isolation, state-read failure, concurrent state transition between early gate and transaction recheck, idempotent retry after reactivation, rollback/evidence behavior, and successful `core.modules.change-tenant-module-state` recovery. Prove the business Action performs exactly one early state acquisition plus one transaction-aware recheck rather than holding a database lock across SpiceDB or Policy evaluation.

### 5. Align Outbox Worker dispatch with the common gate

- [x] Add the structured Worker entrypoint to `OutboxWorkerDescriptor` and validate owner/role/access consistency in registrations, subscriptions, generated catalogs, and unit tests.
- [x] Refactor `packages/core-runtime/src/outbox/repository.ts` so claim eligibility uses the central `background` semantics through a transaction-safe gate/query seam while retaining one atomic claim transaction, exact consumer module ownership, `skipLocked`, lease recovery, retry limits, and deterministic order. Keep state filtering in that claim query; do not add a preliminary or per-delivery module-state query.
- [x] Ensure ineligible or missing states leave deliveries pending and create no claim or attempt. State-read/persistence failures remain typed and distinguishable from handler/decode failures; never authorize from the producer's state.
- [x] Keep `getOutboxWorkerHandler` after an eligible claim and prove an ineligible claim cannot resolve or run the handler. Preserve at-least-once semantics and existing complete/fail/checkpoint transactions.
- [x] Expand unit and PostgreSQL integration tests across all seven states, missing rows, foreign tenants, producer-active/consumer-inactive combinations, reactivation, concurrent claimers, unavailable state reads, no-attempt behavior, and unchanged checkpoint safety. Instrument the repository seam to prove the common gate adds zero database round trips beyond the existing match/claim/finalization operations.

### 6. Force future page, component, API, search, and report integration

- [x] Preserve structured page entrypoints through `scripts/generate-tanstack-routes.mts` and generated route manifests. Reject every MicroVertical route whose module identity, role, access, or topology owner is missing or inconsistent; Shell-owned routes use explicit system classification and do not create tenant-state rows.
- [x] Define the approved lazy Shell composition adapter for page/public-component loads. It must collect all descriptors for one composition, acquire one batch snapshot for their distinct tenant module keys, evaluate every load from that snapshot, and only then call the allowed Module Federation loader thunks. It must never accept raw remote strings at application call sites, eagerly imported remote implementations, or perform one BFF/database lookup per component.
- [x] Extend strict API validation so every future MicroVertical BFF endpoint is registered with a structured `api` entrypoint and invokes the server-side gateway after verified trusted tenant context. One BFF request prepares at most one snapshot for its declared endpoint composition. Read/historical access is explicit; write endpoints must delegate to a registered Action and receive the Action runtime's independent early check plus transaction recheck.
- [x] Reserve generated Vertical Runtime Registration slots for public components, search descriptors, and report descriptors. Each registration must carry a direct typed public descriptor plus a private lazy implementation binding; cross-module consumers may import the public descriptor/client only, never the registration or implementation.
- [x] Until an approved Codesmith command can generate and patch API/public-component/search/report registration safely, make the boundary check reject introduction of those business artifacts with an actionable message to extend Codesmith first. Do not hand-create their initial business files under the exception for infrastructure files.
- [x] When the first generator for one of those categories is added, require it to patch the reserved registration atomically, emit the correct access class, and add disposable compile/overwrite/traversal/no-partial-write tests before any production artifact is generated.
- [x] Add fake-loader tests for page and public-component denial/laziness, API read/write/historical classifications, search normal versus historical reads, report normal versus historical reads, missing trusted tenant context, Core system surfaces, and typed unavailable UI/error mapping. Compose many descriptors spanning repeated and distinct modules and prove one batch acquisition, in-memory reuse, zero system-module reads, and no per-component/search/report query. No production business page/component/API/search/report is required while `verticals/` is empty.

### 7. Add repository enforcement against bypasses

- [x] Add `scripts/check-module-entrypoint-boundaries.mts` with reusable discovery/validation logic for generated Action markers, Worker markers/catalogs, route metadata/manifests, vertical API entries, Module Federation exposes/imports, runtime registration slots, and package public exports.
- [x] Fail on direct imports of another vertical's private routes, handlers, Workers, registrations, search/report implementations, or tables; direct calls to private handler accessors; raw `loadRemote(...)` outside the approved Shell adapter; eager remote implementation imports; owner/role/access mismatches; and discovered artifacts absent from structured registration.
- [x] Reuse existing topology and installed-vertical metadata and existing `validate-ultramodern-workspace.mts` remote-import rules rather than creating a second installed-module inventory. Keep the new check focused on OntOS entrypoint governance.
- [x] Add disposable positive and negative fixtures in `scripts/tests/module-entrypoint-boundaries.test.mts` for every current/future category and each bypass form. Prove errors name the violating file and required generator/gateway without leaking source contents.
- [x] Add `module-entrypoints:check` to `package.json` and the aggregate `check` script. Update `README.md` and CI/workspace validation assertions so removing or bypassing the command fails `contract:check` and `pnpm check`.

### 8. Run all focused and repository validation

- [x] Execute every Validation Command below in order, resolve all failures without weakening the gate or exclusions, confirm only intended files changed, and record any environment-only integration prerequisite separately from product failures.

## Testing Strategy

### Unit Tests

Exhaustively table-test the state/access matrix, including missing state, and test structured
descriptor construction, system classification, immutable values, typed safe failures, dependency
ordering, lazy authorization/load/handler behavior, Action stage order, and Worker descriptor/claim
behavior. Use counting fakes to prove batch-key deduplication, one state acquisition for many
descriptors, request-snapshot reuse, fail-closed undeclared keys, zero queries for system-only
compositions, one early business-Action read, and zero extra Worker queries. Test safe telemetry
attributes without asserting environment-specific timing values. Test Codesmith and the boundary
checker with disposable workspaces so future generated artifacts cannot omit or forge their
entrypoint metadata.

### Integration Tests

Use the existing PostgreSQL-backed Core fixtures to prove tenant-isolated gate reads, Action early
denial and locked recheck, concurrent state changes, recovery through the Core state Action,
Outbox Worker claim eligibility/no-attempt behavior, and reactivation. Add multi-key database
fixtures and repository instrumentation to prove the query budgets without relying on wall-clock
thresholds. No browser E2E test is required while `develop` contains no business MicroVertical
route or remote; fake lazy loaders and disposable generated vertical fixtures provide the current
load-order and batching proof. The first production page/public-component integration must add an
E2E direct-URL/remote-load denial test and verify its state-decision request remains batched.

### Edge Cases

- A tenant/module state row is missing.
- The Core database is unavailable or contains an invalid state despite its check constraint.
- A caller supplies a module key, tenant id, role, or access class that disagrees with the registered descriptor.
- A system Action targets an inactive business module; the Action owner remains system-scoped and recoverable.
- The module changes from active to non-writable after the early Action gate but before the handler transaction.
- An invocation blocked at the locked recheck is retried after reactivation with the same idempotency key.
- A Worker producer is active while its consumer is inactive, and vice versa.
- A delivery remains pending across deactivation/reactivation without gaining an attempt or skipping a checkpoint.
- An inactive, suspended, or archived module is requested through normal read versus explicit historical read.
- A quarantined module is requested through every access class.
- A direct URL, raw Module Federation load, private import, or package export attempts to bypass registration.
- Trusted tenant context is absent for a public-looking module endpoint; it fails closed rather than using a client-supplied tenant.
- A composition contains duplicate entrypoints and multiple roles for the same module; the state key is queried and decoded once.
- A composition contains only Core system entrypoints or no entrypoints; no state query is issued.
- An entrypoint key was not declared when the request snapshot was prepared; it fails closed without an implicit lookup.
- Many public components/search/report descriptors are composed in one request; query count depends on the request batch, not descriptor count.
- Tenant module state changes after a read snapshot is prepared; the current read request remains internally consistent while the next BFF/Action trust boundary observes fresh state.

## Acceptance Criteria

- [x] One documented, exhaustive Core matrix governs every tenant module state and entrypoint access class.
- [x] One trusted request composition loads all distinct tenant module states in at most one indexed batch query and evaluates subsequent checks from one immutable request-scoped snapshot.
- [x] Duplicate/repeated entrypoint checks add no database queries, empty/system-only compositions issue no module-state query, and undeclared snapshot keys fail closed without implicit lookup.
- [x] No process-global, browser-authoritative, TTL, or distributed module-state cache is introduced; each independent trust-boundary request observes state afresh.
- [x] `deprecated` and `read_only` allow reads/historical reads but deny Actions and Workers.
- [x] `inactive`, `suspended`, and `archived` allow only explicitly registered historical reads; `quarantined` allows no module-owned entrypoint.
- [x] Missing or unavailable state never authorizes an entrypoint.
- [x] Core system capabilities bypass tenant activation only through explicit system descriptors and still run all other applicable controls.
- [x] Every Action descriptor declares a structured write entrypoint and the owning module cannot disagree with it.
- [x] A business Action checks state before invocation creation, permission, Policy, or handler resolution and rechecks transactionally before execution.
- [x] A business Action uses one early state read plus one authoritative transactional recheck; a Core system Action performs no tenant-module-state read.
- [x] A pre-invocation Action state denial persists no Action invocation/evidence; a locked recheck cannot commit business/evidence writes.
- [x] `core.modules.change-tenant-module-state` remains authorized through its explicit Core system classification.
- [x] Worker eligibility uses the same background decision; only `active` consumers are claimed, and ineligible deliveries create no attempts.
- [x] Worker gate alignment adds no database round trip beyond the existing transactional claim query.
- [x] Generated Actions, pages, and Workers contain correct structured entrypoints and generator fixtures prevent regression.
- [x] Future APIs, public components, search, and reports cannot pass repository validation without structured registration, approved gateway use, and generator support.
- [x] Raw Module Federation loads and direct private entrypoint imports outside approved Shell/Core gateway code fail the repository check.
- [x] `AGENTS.md` makes the gate and generator requirement mandatory and links one authoritative architecture document.
- [x] Typed failures remain sanitized and are mapped exhaustively at BFF/frontend edges.
- [x] Safe telemetry exposes gate acquisition latency, batch size, snapshot reuse, access/scope, and outcome without payloads, credentials, or raw persistence causes.
- [x] Strict MicroVertical deployment seams, generated Effect BFF clients, Action evidence, Worker leases/checkpoints, and current Shell behavior remain intact.
- [x] All focused validation and `mise exec -- pnpm check` pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck updated Codesmith implementations and disposable generator fixtures.
- `mise exec -- pnpm exec oxlint scripts/scaffolding scripts/check-module-entrypoint-boundaries.mts scripts/tests` — lint generator and boundary infrastructure outside the normal application lint roots.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts scripts/tests/module-entrypoint-boundaries.test.mts` — run generator and fail-closed boundary fixtures.
- `mise exec -- pnpm scaffold:action -- --help` — verify Action help describes governed tenant and explicit Core output.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — verify page help describes governed route output.
- `mise exec -- pnpm scaffold:outbox-worker -- --help` — verify Worker help describes governed background output.
- `mise exec -- pnpm module-entrypoints:check` — validate every current and reserved future entrypoint category and reject bypasses.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — run focused Action descriptor, order, error, laziness, and stage tests.
- `mise exec -- pnpm --filter @app/core-runtime outbox:test:unit` — run focused Worker descriptor, claim, handler, and gate tests.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — typecheck the Core gate/gateway, Action/Worker integration, and tests.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — run Core unit and PostgreSQL integration coverage for state, Actions, Workers, concurrency, and tenant isolation.
- `mise exec -- pnpm api:check` — validate strict Effect APIs and required future module API gateway composition.
- `mise exec -- pnpm contract:check` — validate topology, routes, Module Federation, generated catalogs, and the required boundary command wiring.
- `mise exec -- pnpm build` — prove production Shell, Effect BFF, route metadata, and Module Federation output remain valid.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Implemented the universal descriptor, closed state/access matrix, immutable request snapshot,
  Core gate/gateway, Action early gate plus transactional recheck, Worker claim alignment, lazy
  Shell adapter, Codesmith output, documentation, and repository bypass enforcement.
- Hardened the final design so only Core can mint snapshots, snapshots authorize exactly their
  prepared descriptors, tenant/system ownership is enforced, trusted principal context is runtime
  validated, all composed Shell descriptors are preflighted before loading, and typed loader and
  persistence failures remain intact behind safe public errors.
- Added safe gate telemetry and comment-aware TypeScript boundary inspection without recording
  tenant, module, principal, entrypoint, payload, credential, or raw persistence information.

### Changed Files

- 56 intended paths under `app/` totaling 4,071 additions and 103 deletions: Core gate/runtime
  code and tests, Shell gateway metadata and tests, Codesmith and boundary tooling, architecture
  guidance, CI/package wiring, and this spec.
- No files under read-only `mvp/` or `mvp2/` were changed.

### Tests Written or Updated

- Added exhaustive unit/integration coverage for descriptor construction, state/access decisions,
  immutable snapshots, batching/reuse, unavailable state, Action ordering and transactional
  rechecks, system recovery, Worker claim eligibility, Shell lazy composition, telemetry safety,
  Codesmith output, and every enforced bypass category.
- Added PostgreSQL coverage for all states, missing and foreign-tenant rows, concurrent state
  transition, retry after reactivation, rollback/evidence behavior, and consumer-owned Worker
  state. Database-enabled review also corrected stable fixture keys, tenant-state-change cleanup,
  and a faithful unavailable-query fake.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- pnpm exec oxlint scripts/scaffolding scripts/check-module-entrypoint-boundaries.mts scripts/tests` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts scripts/tests/module-entrypoint-boundaries.test.mts` — passed, 36 tests.
- `mise exec -- pnpm scaffold:action -- --help` — passed.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — passed.
- `mise exec -- pnpm scaffold:outbox-worker -- --help` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed, 51 tests.
- `mise exec -- pnpm --filter @app/core-runtime outbox:test:unit` — passed, 17 tests.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — passed.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — passed, 133 tests, using isolated
  process-scoped PostgreSQL and SpiceDB test services after applying the repository migrations.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm contract:check` — passed.
- `mise exec -- pnpm build` — passed.
- `mise exec -- pnpm check` — passed.
- Additional verification: Core migrations and exact 18-table schema verification passed against
  the isolated PostgreSQL database; all 66 Shell unit tests and 9 focused gate tests passed.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, and every architecture, frontend, product-context,
  manifest, validation-report, and ADR reference named by this spec. The final implementation
  preserves the documented Core/MicroVertical ownership, Action evidence, Worker claim,
  generated BFF, trusted-context, typed-error, and historical-read boundaries.
- Final review found and corrected generator stale-entrypoint validation, reference-topology
  wiring, integration hook order, public snapshot forgery, ownership/context bypasses, partial
  Shell loading, erased loader errors, formatting-sensitive boundary checks, API discovery,
  telemetry coverage, and the three database-fixture defects above. No findings remain.

### Deviations and Follow-ups

- None required for this feature. No browser E2E was added because there is still no production
  business MicroVertical route or remote; the spec explicitly uses fake lazy loaders and
  disposable generated fixtures until the first production integration exists.

## Notes

- This plan is based solely on local `develop` at commit `cc4fefea4940a1dab097148a93ce65199fddd957`; the worktree was clean and `develop` was two commits ahead of `origin/develop` when planning began.
- The complete OntOS Module Manifest is not a prerequisite. The structured entrypoint value and private registration slots must be designed so a later manifest can embed/reuse them without changing gate semantics.
- `deprecated` is intentionally read-only, per the developer decision on 2026-08-06. Exceptional compatibility writes require a later explicit architecture decision and must not be expressible through a local module override.
- Explicit historical access is allowed for inactive, suspended, and archived states to preserve company memory, subject to later SpiceDB/Policy checks. It is never ordinary navigation and is denied during quarantine.
- The existing Shell `activeModules` endpoint/UI remains exact-active in this feature. Root product guidance to show `read_only` and `deprecated` navigation with indicators is compatible with the matrix but requires a separate user-facing contract and UI change.
- Public business entrypoints without trusted tenant resolution remain intentionally unsupported and fail closed. A future host/domain/resource tenant-resolution design must integrate before such an entrypoint can be registered; client-supplied tenant identity is forbidden.
- Request-scoped snapshots deliberately trade cross-request caching for immediate, simple correctness: one request sees one immutable state view, while the next independent Shell/BFF request reloads current state. Introduce distributed or TTL caching only after production telemetry proves the indexed batch read is material and an invalidation protocol is approved.
- Query-count budgets are contractual and deterministic; wall-clock latency thresholds are not fixed before a representative database/deployment benchmark exists. Telemetry added by this feature supplies the evidence for a later numeric service-level objective.
- No new production Action, page, Outbox Message, Policy, API, public component, search descriptor, report, or Worker is created by this feature. Generator changes adapt future output and the existing Core Action descriptor, so no production scaffold command is required to create a new business artifact.
