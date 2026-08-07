---
type: feature
status: planned
created: 2026-08-07
---

# Feature: Module-aware Shell composition

## Feature Description

Build the missing Shell/Core composition boundary that turns the deployment-safe Installed Module Catalog, owner-local Vertical Runtime Registrations, tenant module state, and user/context permissions into one server-resolved Shell composition model.

The model must be the only source for Shell navigation, guarded module entrypoints, and cross-module affordances. It must cover module pages, global search, resource detail, timeline, and media attachment infrastructure even though no production MicroVertical or provider exists yet. Synthetic deployment contracts and loader/provider adapters will prove the boundary without adding business functionality.

The Shell remains responsible for URLs, layout, tenant context, navigation, loading and error states, and the decision to expose or invoke a remote capability. Independently deployed modules remain responsible for their manifests, owner-local executable registrations, components, APIs, Actions, and provider implementations. Executable functions, import paths, private route trees, and runtime registration objects must not cross deployment contracts.

## User Story

As an authenticated OntOS user
I want the Shell to show and open only the module capabilities that are valid for my tenant, module state, and permissions
So that navigation and every cross-module entrypoint behave consistently and safely as independently deployed modules are installed or change state

## Problem Statement

The current `develop` branch has the important lower-level pieces but does not compose them into Shell behavior. It can discover allowlisted deployment contracts in an Installed Module Catalog, define owner-local Vertical Runtime Registrations, and gate structured entrypoints by tenant module state. The Shell still reads `GET /modules/active`, receives only `{ moduleKey, state: "active" }`, guesses `/${moduleKey}` links, and has no module-level permission decision, guarded remote route, or shared composition model for search, resource detail, timeline, and media attachment.

This creates several gaps:

- `read_only` and `deprecated` modules cannot appear with state-aware behavior.
- A module without user permission cannot remain visible but inaccessible.
- Navigation does not prove that a declared page/component is installed before creating a link.
- A direct URL is not resolved server-side against installation, the target module's tenant state, permission, and entrypoint access before remote code loads.
- Search, resource detail, timeline, and media attachment have no Shell-owned provider resolution boundary or defined empty/degraded behavior.
- The current page generator/route validation path does not consistently preserve the already-established distinction between deployment `appId` and module `moduleId`.

## Solution Statement

Extend the module contract with a small, serializable set of Shell contribution descriptors that bind stable semantic keys to existing manifest components, APIs, Actions, search descriptors, resource types, and structured entrypoints. Vertical Runtime Registrations will keep executable values owner-local and expose only validated, frozen safe descriptor projections in the deployment contract. The Shell will never consume another deployment's private registration or route implementation.

Add a tenant-and-module-scoped bulk authorization service in Core, then implement a pure Shell composition service with a narrow interface: compose the current user's navigation and affordance model, and resolve a requested Shell target. It will combine the Installed Module Catalog, one batched tenant-state snapshot, and one bulk permission snapshot. The BFF will expose typed Effect contracts for the composition and target-specific affordances.

The resulting behavior is:

- `active`, `read_only`, and `deprecated` modules are visible in normal navigation.
- A visible module with denied permission stays visible but is non-interactive; a direct request returns a typed 403 response.
- A permission service outage keeps otherwise visible modules visible but unavailable; direct requests return a retryable 503 response.
- `inactive`, `suspended`, `quarantined`, and `archived` modules are absent from normal navigation, and normal module URLs return the Shell's explanatory 404 page. Explicit historical-resource entrypoints remain governed by the existing `historical_read` state-gate rule.
- `read_only` and `deprecated` modules allow read entrypoints but expose write affordances as disabled; server-side Action enforcement remains authoritative.
- The Shell resolves and authorizes a structured target on the server before invoking the existing lazy Module Federation entrypoint loader. A remote-load failure renders a retryable error without weakening the gate.
- Global search is always present. With no eligible providers it succeeds with an empty result set.
- Resource detail, timeline, and media attachment are Shell-owned entrypoints resolved from safe descriptors. No provider produces a defined empty/404/disabled state instead of requiring a production MicroVertical.

## Relevant Files

Use these files to implement the feature:

- `packages/core-runtime/src/modules/manifest.ts` — defines public manifest data and the serialized deployment contract that needs safe Shell contribution descriptors.
- `packages/core-runtime/src/modules/runtime-registration.ts` — keeps executable runtime values private and produces the safe descriptor projection consumed by contract generation.
- `packages/core-runtime/src/modules/catalog.ts` — provides the immutable installed-module lookup and contract safety validation used by composition.
- `packages/core-runtime/src/modules/module-entrypoint.ts` — owns structured entrypoint roles and access classes used by all composed targets.
- `packages/core-runtime/src/modules/module-state-gate.ts` — remains the single tenant-state truth table for route, component, search, report, worker, and Action access.
- `packages/core-runtime/src/modules/module-entrypoint-gateway.ts` — preserves the required state-check, authorization, then lazy-load order.
- `packages/core-runtime/src/permissions/service.ts` — contains the existing SpiceDB client lifecycle and Action authorization implementation to share without duplicating transport concerns.
- `packages/core-runtime/spicedb/bootstrap.yaml` — needs the tenant-scoped module-access authorization definition and assertions.
- `packages/core-runtime/tests/unit/module-state-gate.test.ts` — protects the established state/access matrix that composition must reuse rather than reimplement.
- `packages/core-runtime/tests/integration/module-state-gate.test.ts` — proves batched snapshots and state changes at the database boundary.
- `apps/shell-super-app/api/modules/deployment-allowlist.ts` — constrains which independently deployed module contracts the Shell may discover.
- `apps/shell-super-app/api/modules/installed-module-catalog.ts` — loads the deployment-safe Installed Module Catalog used as the composition input.
- `apps/shell-super-app/api/index.ts` — currently implements `GET /modules/active` and must wire the typed composition and target-resolution handlers.
- `apps/shell-super-app/shared/api.ts` — currently exposes the active-only response and must define the Effect schemas and declared Problem Details for composition APIs.
- `apps/shell-super-app/src/api/auth-client.ts` — current generated-client wrapper for module, session, and tenant calls; update it to consume the replacement module composition endpoint.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — currently loads active modules and must load the authenticated Shell composition model.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — current authenticated home page and composition loading/degraded-state integration point.
- `apps/shell-super-app/src/routes/shell-frame.tsx` — currently guesses module URLs from module keys; must render the server-composed navigation and persistent global search affordance.
- `apps/shell-super-app/src/routes/module-entrypoint-loader.ts` — existing Shell adapter that batches state checks and delays lazy loads until authorization succeeds.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — current active-module BFF tests to replace with composition, permission, and failure-path coverage.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — validates the Shell Effect API endpoint and schema surface.
- `apps/shell-super-app/tests/unit/layout.test.tsx` — validates responsive and accessible Shell navigation states.
- `apps/shell-super-app/tests/unit/module-entrypoint-loader.test.ts` — validates that remote components are not loaded before state and authorization decisions.
- `scripts/scaffolding/module-contract/scaffold.mts` — must generate empty, valid contribution slots for a new deployment contract.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — must register page metadata through the owner-local contribution seam rather than create Shell-owned route wiring.
- `scripts/generate-tanstack-routes.mts` — must validate page ownership using `moduleId` while retaining `appId` solely as deployment identity.
- `scripts/check-ontos-module-contracts.mts` — validates authored manifests, safe projections, deployment contracts, and cross-references.
- `scripts/check-module-entrypoint-boundaries.mts` — enforces structured entrypoint and lazy-loading boundaries.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` — validates newly generated empty contribution slots and serialization.
- `scripts/tests/module-entrypoint-boundaries.test.mts` — protects forbidden eager imports, raw entrypoint strings, and bypasses.
- `docs/architecture/MODULE_MANIFESTS.md` — documents the safe Shell projection without permitting serialized route implementations or executable values.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — documents the complete composition and guarded-loading sequence.
- `docs/frontend/FRONTEND.md` — documents Shell-owned loading, empty, forbidden, unavailable, retry, responsive, and accessibility behavior.
- `README.md` — exposes the validation/generator workflow if the contribution authoring contract changes developer usage.

### New Files

- `packages/core-runtime/src/modules/shell-contribution.ts` — schemas and pure validation for serializable navigation, page, resource-detail, search, timeline, and media-attachment bindings.
- `packages/core-runtime/src/permissions/module-access.ts` — tenant/module-scoped bulk permission service, typed decisions, SpiceDB object-ID mapping, and live/test layers.
- `packages/core-runtime/tests/unit/shell-contribution.test.ts` — exact-schema, ownership, reference, ordering, duplicate, and no-executable-value tests.
- `packages/core-runtime/tests/unit/module-access.test.ts` — bulk request/response classification, fail-closed, timeout, malformed-response, and client-lifecycle tests.
- `packages/core-runtime/tests/integration/module-access.test.ts` — SpiceDB schema and tenant/module isolation tests.
- `apps/shell-super-app/api/modules/shell-composition.ts` — pure Shell composition and target-resolution service over catalog, state, and permission inputs.
- `apps/shell-super-app/tests/unit/shell-composition.test.ts` — composition truth-table and provider-resolution tests using synthetic contracts.
- `apps/shell-super-app/tests/unit/routes/module-target/page.test.tsx` — guarded module target loading, 404, forbidden, unavailable, and retry rendering tests.
- `apps/shell-super-app/tests/unit/routes/search/page.test.tsx` — persistent search and zero-provider empty-result behavior tests.
- `apps/shell-super-app/tests/unit/routes/resource-detail/page.test.tsx` — resource, timeline, and media capability state tests with synthetic descriptors.

## Implementation Plan

### Phase 1: Foundation

Define the safe Shell contribution vocabulary and its ownership/reference invariants. Extend the owner-local Vertical Runtime Registration and deployment contract serializer without exposing functions, schemas, private routes, arbitrary URLs, or import paths. Correct generator and validator behavior around `appId` versus `moduleId`. Add the tenant/module bulk authorization service and SpiceDB schema before the Shell starts consuming permission decisions.

### Phase 2: Core Implementation

Implement one pure Shell composition service that evaluates installed contracts, the batched module-state snapshot, and bulk module-access decisions. Replace the active-only BFF contract with typed composition responses and target resolvers. Add Shell-owned module, search, and resource affordance routes that reuse the existing state gate and module entrypoint gateway before any remote loader or provider is invoked.

### Phase 3: Integration

Render the composition model in the authenticated layout with UI-kit components, generated URLs, state badges, disabled inaccessible items, a persistent SearchForm, and complete loading/error/empty/retry states. Prove the end-to-end boundary using synthetic deployment contracts and test loaders only. Update architecture/frontend documentation and run all focused and repository-wide validation.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define deployment-safe Shell contribution contracts

- [ ] Add `packages/core-runtime/src/modules/shell-contribution.ts` with exact Effect schemas for semantic Shell target keys and bindings for module navigation/page components, resource-detail components, search APIs, timeline APIs/events, and media-attachment Actions. Bindings must reference existing manifest keys plus a structured `ModuleEntrypointDescriptor`; they must not contain React values, Effect schemas, handlers, remote URLs, import paths, arbitrary route paths, or TanStack/Modern.js route objects.
- [ ] Keep URL construction and localized Shell copy out of remote descriptors: the Shell derives stable URLs from target kind/key, uses `manifest.module.displayName` for the initial module label, and owns generic state/error copy.
- [ ] Validate exact keys, uniqueness, module ownership, supported entrypoint role/access combinations, and every referenced component/API operation/Action/search/resource/event key against the same authored manifest.
- [ ] Add `packages/core-runtime/tests/unit/shell-contribution.test.ts` with valid empty/full synthetic inputs and rejection tests for cross-module ownership, missing references, duplicate keys, write bindings with non-write access, non-serializable/private fields, and unstable ordering.

### 2. Extend Vertical Runtime Registration and serialized deployment contracts

- [ ] Extend `packages/core-runtime/src/modules/runtime-registration.ts` so owner-local registrations accept Shell bindings alongside Actions and Outbox Workers, retain all executable values in the existing private WeakMap seam, and return only copied/frozen safe descriptors from `extractVerticalRuntimeSafeDescriptors`.
- [ ] Extend `packages/core-runtime/src/modules/manifest.ts` and its schema version deliberately so `runtime` carries the safe Shell projection. Reject old/new incompatible schema versions through the existing installed-catalog decoder instead of silently accepting them.
- [ ] Update manifest, registration, catalog, and deployment-contract tests to prove JSON round trips, exact schema rejection, immutability, deterministic output, and that no executable registration value leaks into `ONTOS_MODULE_CONTRACT_PATH`.

### 3. Make Codesmith and validators own contribution wiring

- [ ] Update `scripts/scaffolding/module-contract/scaffold.mts` and its templates so every new module contract starts with explicit empty Shell contribution collections and still passes contract checks without creating any business artifact.
- [ ] Update `scripts/scaffolding/microvertical-page/scaffold.mts` so a future generated page atomically adds its structured page/component binding to the owner-local registration; do not hand-author a production page for this feature.
- [ ] Correct `scripts/generate-tanstack-routes.mts` and its fixtures so page entrypoint ownership compares `entrypoint.moduleKey` with `moduleId`, not deployment `appId`, while Module Federation discovery continues to use `appId`/`mfBoundaryId`.
- [ ] Extend `scripts/check-ontos-module-contracts.mts` and `scripts/check-module-entrypoint-boundaries.mts` to validate contribution references and reject raw remote imports, eager loads, arbitrary remote route trees, or Shell imports of another deployment's private registration/source.
- [ ] Add generator/boundary regression tests using temporary synthetic workspaces only. Keep the existing rule that a future business artifact category cannot be authored until its matching Codesmith generator and enforced gateway exist.

### 4. Add tenant-scoped bulk module authorization

- [ ] Extract only the now-reused SpiceDB transport/lifecycle primitives from `packages/core-runtime/src/permissions/service.ts`; preserve the public ActionPermission behavior and tests.
- [ ] Add `packages/core-runtime/src/permissions/module-access.ts` with a single bulk interface that accepts `tenantId`, `principalId`, `correlationId`, and installed `moduleIds`, and returns an exhaustive decision for every requested module: `allowed`, `denied`, or `unavailable`.
- [ ] Use Authzed's stable `CheckBulkPermissions` API with a lossless tenant+module object-ID encoding and fully consistent reads. Treat absent relations as denied; treat missing/malformed pairs, partial bulk responses, timeouts, transport failures, or configuration failures as unavailable. Never upgrade uncertainty to allowed.
- [ ] Extend `packages/core-runtime/spicedb/bootstrap.yaml` with tenant/module-isolated access relationships and assertions. Add unit and integration tests proving one tenant's permission cannot authorize another tenant, duplicate/unknown responses fail closed, and the existing Action authorization behavior is unchanged.

### 5. Implement the pure Shell composition model

- [ ] Add `apps/shell-super-app/api/modules/shell-composition.ts` with two entrypoints: `compose(context)` for the complete Shell view model and `resolveTarget(context, target)` for a specific module/search/resource/timeline/media request. Accept the Installed Module Catalog, ModuleStateGate, and ModuleAccess service as injected interfaces so tests require no deployed MicroVertical.
- [ ] Read tenant module states in one `getMany` request and user access in one bulk permission request. Sort output deterministically by display name then module ID; never issue per-navigation-item state or authorization calls.
- [ ] Centralize policy outcomes: visible states are `active`, `read_only`, and `deprecated`; hidden normal states are `inactive`, `suspended`, `quarantined`, and `archived`; denied access is visible/inaccessible; unavailable access or a missing landing-page binding is visible/unavailable; `read_only` and `deprecated` expose `writable: false`.
- [ ] Treat every installed module independently. Published API, event, component, and Outbox references may affect only whether that specific affordance has a provider; they must never alter module installation, navigation eligibility, tenant-state decisions, or another module's lifecycle.
- [ ] Delegate entrypoint legality to `ModuleStateGate`/`ModuleEntrypointGateway`, including explicit `historical_read`; do not copy the state matrix into Shell conditionals. Validate all target keys against the installed catalog and safe contribution projection before authorization.
- [ ] Return a serializable discriminated model containing generated `href` only for interactive navigation, state/status labels as stable enum values, allowed affordances, and typed resolution outcomes (`resolved`, `not_found`, `forbidden`, `unavailable`). Include no remote implementation detail beyond the already-approved structured component/API/Action identifiers needed by the guarded adapter.
- [ ] Add `apps/shell-super-app/tests/unit/shell-composition.test.ts` covering every tenant state, permission result, missing/invalid bindings, appId/moduleId differences, no installed modules, absent providers, historical reads, independent module lifecycles, and deterministic ordering.

### 6. Replace the active-only Shell BFF contract

- [ ] Replace `ActiveModule`/`ActiveModules` and the `activeModules` endpoint in `apps/shell-super-app/shared/api.ts` with exact Effect schemas for the composition model and target-specific search/resource resolution. Declare typed Problem Details for authentication-required 401, permission-denied 403, target-not-found 404, retryable authorization/provider 503, and internal 500 failures according to `docs/architecture/ERRORS.md`.
- [ ] Wire the services in `apps/shell-super-app/api/index.ts`; preserve authenticated tenant/principal derivation at the BFF boundary and never accept tenant or principal identity from browser payloads.
- [ ] Return a degraded 200 composition when the catalog/state snapshot is known and only module permission checks are unavailable, so visible modules remain present but non-interactive. Return retryable 503 when installation or tenant-state inputs cannot be established safely.
- [ ] Update `apps/shell-super-app/src/api/auth-client.ts`, contract tests, schema tests, runtime tests, and integration tests to remove `GET /modules/active`, consume the generated Effect client, and prove all declared status/error mappings without raw `fetch`, `any`, or untyped JSON parsing.

### 7. Integrate composition into authenticated server loading

- [ ] Replace `activeModules` loading in `apps/shell-super-app/src/routes/[lang]/page.data.ts` with the composition client and expose explicit `loading`, `ready`, and retryable `unavailable` model states while preserving authentication and tenant-switch behavior.
- [ ] Update `apps/shell-super-app/src/routes/[lang]/page.tsx` and loader/page tests so first render is based on server-resolved composition, empty installation is a successful empty state, and a retryable composition failure is announced without exposing unverified links.
- [ ] Re-resolve the composition after tenant changes; do not reuse navigation, permission, provider, or target decisions from the previous tenant context.

### 8. Render state-aware navigation and persistent global search

- [ ] Refactor `apps/shell-super-app/src/routes/shell-frame.tsx` to accept composed navigation items rather than module keys. Use `@techsio/ui-kit` Link with the existing Modern i18n adapter only when an item has an allowed `href`; render denied/unavailable items as non-interactive semantic content with `aria-disabled="true"`, never as fake disabled links.
- [ ] Use UI-kit Badge for `read_only`, `deprecated`, denied, and unavailable status; StatusText for composition/search errors; Button for retry; and SearchForm for the always-present global search landmark. Do not add a legal-entity selector or modify `libs/ui`.
- [ ] Keep SearchForm present when zero providers are eligible and render a successful empty result state. Disable submission only while loading/submitting or when composition is unavailable, not merely because no provider exists.
- [ ] Extend layout and route component tests for keyboard order, focusable versus non-focusable navigation, `aria-current`, status announcement, accessible names, search empty/error/retry, narrow-screen behavior, and no horizontal overflow.

### 9. Add the guarded module target boundary

- [ ] Add a Shell-owned parameterized module target route using the repository's Modern.js filesystem routing convention while preserving the current localized URL boundary. Resolve the stable Shell target key on the server before passing the approved component descriptor to `apps/shell-super-app/src/routes/module-entrypoint-loader.ts`.
- [ ] Keep the execution order explicit and tested: installed contract/reference validation, batched tenant-state gate, module permission authorization, then lazy Module Federation load. No remote import may execute on 404, 403, or 503 outcomes.
- [ ] Render the Shell's localized explanatory 404 page for unknown modules/targets and normal URLs in hidden states, with generic copy equivalent to “This module or page is not available for the current tenant”; render forbidden UI with HTTP 403 for permission denial; render retryable unavailable UI with HTTP 503 for authorization or provider uncertainty; and render a retryable in-Shell error if an allowed active/readable remote component fails to load.
- [ ] Extend `module-entrypoint-loader.test.ts` and add route tests with synthetic descriptors/lazy-loader spies for every outcome, including state or permission changing between navigation composition and target resolution.

### 10. Add Shell-owned search provider composition

- [ ] Resolve eligible search descriptors from the installed catalog and safe search-to-API bindings for the current tenant/user/query. Apply target validation, state access, module permission, and resource filtering before invoking any provider through its declared API operation.
- [ ] Aggregate successful provider results into one stable Shell result contract, preserve module/resource ownership on each item, and make an empty eligible-provider set return `[]`. When at least one provider succeeds, return its results with a typed partial-result warning for failed providers; when every eligible provider fails, return a retryable failure. Use this rule consistently in the API, UI, and tests.
- [ ] Add unit, BFF integration, and SearchForm page tests for zero providers, denied/hidden providers, mixed success, all-provider failure, malformed provider results, cancellation/debouncing as supported by the current SearchForm integration, and result links resolved through the Shell resource target rather than remote URLs.

### 11. Add resource detail, timeline, and media attachment composition

- [ ] Add a Shell-owned resource target route that resolves `resourceType` through the Installed Module Catalog and safe resource-detail binding before invoking a provider. Unknown resource types, absent detail bindings, and hidden normal targets return the explanatory 404; denied access returns 403; unavailable checks return retryable 503.
- [ ] Compose timeline providers only after resource detail resolution and authorization. An eligible resource with no timeline provider/events renders a successful empty timeline; provider failures use typed retry behavior and cannot bypass resource/module access.
- [ ] Derive media attachment availability from the resource type's `mediaAttachable` capability, a declared media Action binding, entrypoint state access, module permission, and tenant state. Render the attachment entry point disabled when absent, denied, `read_only`, or `deprecated`; any enabled mutation must execute the declared generated Action through the existing Action gateway and never write directly.
- [ ] Add resource page tests using synthetic contracts/provider adapters for loading, missing resource, empty timeline, provider error/retry, forbidden access, stale tenant context, read-only/deprecated disabled attachment, accessible disabled explanations, and responsive layout. Do not create a production resource, Action, page, provider, or MicroVertical.

### 12. Document and enforce the completed boundary

- [ ] Update `docs/architecture/MODULE_MANIFESTS.md` to distinguish an owner-local runtime registration, its safe serialized Shell projection, and the Shell Installed Module Catalog. Clarify that semantic target descriptors are allowed while executable route trees, arbitrary paths, handlers, schemas, and imports remain forbidden across deployments.
- [ ] Update `docs/architecture/MODULE_ENTRYPOINTS.md` with the complete composition/target-resolution sequence and HTTP/UI outcome table. Update `docs/frontend/FRONTEND.md` with navigation, search, 404, forbidden, unavailable, retry, accessibility, and responsive expectations.
- [ ] Update `README.md` only if contribution authoring or validation commands change. Keep app documentation authoritative; record the conflicting static-registry wording in repository-level `../docs` as a separate follow-up because this plan is constrained to `app/`.
- [ ] Add boundary fixtures proving the Shell imports contracts/core interfaces only and cannot statically import a production Vertical manifest, registration, route implementation, or remote component.

### 13. Run the complete validation suite

- [ ] From `app/`, execute every command in `Validation Commands` in order. Fix only regressions caused by this feature, confirm all generated files are current, and finish with a clean `git diff --check` and the full repository quality gate.

## Testing Strategy

### Unit Tests

Use exact-schema and pure-policy tests for Shell contribution definitions, runtime safe projection, module authorization bulk classification, composition state/permission truth tables, generated href/status models, independent lifecycle behavior, and provider resolution. Component tests verify UI-kit integration, persistent empty search, disabled versus linked navigation, badges, HTTP-state views, retry actions, keyboard/focus semantics, and responsive layout. Lazy-loader spies must prove forbidden, missing, unavailable, and write-disabled paths never evaluate a remote import or provider.

### Integration Tests

Use the local SpiceDB bootstrap to prove tenant/module permission isolation and bulk checks. Exercise the Shell Effect BFF through its generated client contracts for authenticated composition, degraded permission availability, target 403/404/503 results, zero-provider search, resource/timeline/media resolution, and typed provider failures. Exercise Codesmith and boundary scripts against temporary synthetic deployment fixtures. Browser tests verify the SSR-visible navigation/search shell, stable 404/forbidden/unavailable pages, tenant-switch recomposition, and retryable remote-load behavior without adding a production MicroVertical.

### Edge Cases

- The deployment allowlist is empty or every visible-state module has no user permission.
- `appId` and `moduleId` differ, and two deployments attempt to claim the same module or contribution key.
- The catalog is stale, malformed, oversized, timed out, or on an unsupported contract schema version.
- A module state changes after navigation composition but before direct target resolution or write execution.
- A published provider target is not installed or eligible; the owning module remains independently installable and its base composition remains governed only by its own state and permission.
- SpiceDB returns no tuple, partial bulk pairs, duplicates, unknown resources, malformed permissionship, timeout, or transport failure.
- A visible module has no landing-page binding, or a binding references a missing component/API/Action/resource key.
- A normal archived/inactive URL is requested while an explicit historical-resource entrypoint uses `historical_read`.
- Search has zero providers, every provider is filtered out, one provider fails, all providers fail, or results reference an invalid resource target.
- Resource detail exists with no timeline events/provider and no media Action.
- A media-capable resource is in `read_only` or `deprecated` state, or permission disappears immediately before mutation.
- An authorized remote component or provider fails, times out, or returns an invalid contract after the gate succeeds.
- The Shell renders on a narrow viewport, with keyboard-only input, reduced motion, or assistive technology status announcements.

## Acceptance Criteria

- [ ] The Shell derives one serializable composition model from the Installed Module Catalog, safe Vertical Runtime Registration projections, a batched tenant module-state snapshot, and bulk user/context permissions.
- [ ] No production MicroVertical, page, resource, provider, Action, or business-specific route is created by this feature.
- [ ] No executable runtime registration value, private route tree, arbitrary remote path/import, or implementation function crosses a deployment contract.
- [ ] `active`, `read_only`, and `deprecated` modules appear in normal navigation; `inactive`, `suspended`, `quarantined`, and `archived` modules do not.
- [ ] Permission-denied modules remain visible but inaccessible, with no link or remote load; direct access produces a typed HTTP 403 page.
- [ ] Permission-check outages keep known visible modules visible but unavailable; direct access produces a retryable typed HTTP 503 page.
- [ ] Unknown/uninstalled targets and normal URLs for hidden-state modules produce an explanatory Shell HTTP 404 page.
- [ ] `read_only` and `deprecated` modules allow eligible reads and expose every write/media-attachment affordance as disabled; server-side Action/state checks remain authoritative.
- [ ] A visible installed module without a valid landing-page binding remains visible but unavailable and never receives a guessed URL.
- [ ] Every module route/component/provider is resolved and authorized on the server before lazy remote code or provider invocation begins.
- [ ] An authorized remote-load failure produces a retryable Shell error without bypassing installation, state, or permission checks.
- [ ] Global search is always present and returns an empty successful result when no provider is eligible.
- [ ] Resource detail, timeline, and media attachment have Shell-owned resolver contracts and defined absent, empty, forbidden, unavailable, read-only, and retry states.
- [ ] Tenant switching invalidates and recomputes composition and target decisions.
- [ ] The Shell uses generated Effect clients and declared Problem Details; no raw fetch or untyped error/JSON boundary is introduced.
- [ ] Codesmith-generated module contracts include valid empty contribution slots, and future generated pages register through the owner-local seam while preserving `appId`/`moduleId` separation.
- [ ] Synthetic contract, authorization, BFF, component, integration, generator, boundary, and browser tests prove the full infrastructure without a production MicroVertical.
- [ ] Navigation, global search, state/error feedback, and disabled affordances are keyboard accessible, screen-reader understandable, and usable without horizontal overflow on narrow screens.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — Type-check Codesmith generator and validation scripts.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — Run generator contract and fixture tests.
- `mise exec -- node --test scripts/tests/*.test.mts` — Run repository boundary and generated-artifact tests.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Protect existing Action permission and gateway behavior after sharing the SpiceDB client seam.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Run Core unit/integration tests, including state gate and module-access isolation.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Run Shell schemas, composition, loaders, routes, and component tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — Run typed BFF composition and target-resolution integration tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — Run authenticated Shell, navigation, search, target-state, tenant-switch, and retry browser tests.
- `mise exec -- pnpm i18n:boundaries` — Validate localized-route and translation boundaries.
- `mise exec -- pnpm api:check` — Validate generated Effect API clients and contracts are current.
- `mise exec -- pnpm module-entrypoints:check` — Enforce structured entrypoint and lazy-load boundaries.
- `mise exec -- pnpm check:module-contracts` — Validate authored/serialized module contracts and safe Shell contribution references.
- `mise exec -- pnpm contract:check` — Validate generated topology and contract artifacts.
- `mise exec -- pnpm typecheck` — Type-check every workspace package and application.
- `mise exec -- pnpm build` — Build all independently deployed applications and shared packages.
- `git diff --check` — Reject whitespace errors and malformed patches.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This is intentionally a feature rather than a chore because it creates new observable Shell behavior and the architectural boundary required for future independently deployed modules.
- The plan is based on `develop` at commit `511a7e9`. The deployment-safe manifest/catalog and universal state gate added by the latest commits are prerequisites to reuse, not work to duplicate.
- The authoritative `app/docs/architecture/MODULE_MANIFESTS.md` deployment model supersedes older repository-level wording that suggests statically importing an Installed Vertical Registry. Here, “Installed Vertical Registry” means the Shell's deployment-allowlisted Installed Module Catalog assembled from remote serialized contracts.
- Vertical Runtime Registrations remain owner-local. Only their validated safe descriptor projection participates in Shell composition.
- The existing tenant selector remains in scope as composition context. A legal-entity selector is explicitly out of scope because there is no current business requirement to expose one.
- The installed `@techsio/ui-kit` package is version `0.25.1`, while the available usage-skill metadata references `0.3.2`. Implementation must treat installed TypeScript declarations and existing Shell adapter patterns as authoritative and must not change `libs/ui` for this feature.
- No mandatory business generator is invoked as the first task because this plan creates no Action, MicroVertical page, Outbox Message, or Policy. It modifies the module-contract/page generators and validates them with synthetic temporary fixtures.
- Search partial-success behavior is fixed for this plan as results plus an announced warning when at least one provider succeeds; all-provider failure is retryable.
