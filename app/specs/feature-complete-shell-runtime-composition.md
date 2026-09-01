---
type: feature
status: complete
created: 2026-08-07
---

# Feature: Complete module-aware Shell runtime composition

## Feature Description

Complete the Application Shell described by the OntOS architecture. The Shell must turn the allowlisted Installed Module Catalog, exactly one trusted tenant/legal-entity context, tenant module lifecycle state, and user permissions into the navigation and runtime composition visible to an authenticated user.

The feature covers the complete Shell-owned surface: responsive layout, tenant and legal-entity selection, module-aware navigation, guarded MicroVertical page/component mounting, global search, resource-detail routes, resource timelines, and media-attachment entry points. It establishes working infrastructure and explicit empty/degraded states without inventing a production business MicroVertical. Independently deployed MicroVerticals continue to own their routes, BFFs, Actions, resource implementations, search/report providers, and private runtime registrations.

## User Story

As an authenticated OntOS operator
I want the Shell to compose navigation, modules, resources, search, timelines, and media tools for my selected tenant and legal entity
So that I can move safely across independently deployed business capabilities without seeing or loading code and data that are inactive, inaccessible, or outside my current company context

## Problem Statement

On `develop`, the Shell authenticates users, persists an active tenant, renders the dashboard layout, and lists exact-active module IDs as guessed links. The repository also contains an allowlisted deployment-contract catalog, structured module entrypoints, a tenant-state matrix, and a lazy Shell entrypoint adapter. These pieces are not connected into an authoritative Shell composition flow.

Consequently:

- navigation is derived from raw module IDs rather than declared page contributions;
- direct URLs are not resolved against installation, current context, lifecycle state, and permission before private code loads;
- the Shell has no active legal-entity selection even though `core.legal_entities`, optional `TrustedPrincipalContext.legalEntityId`, and legal-entity columns already exist;
- read-only, deprecated, forbidden, and temporarily unavailable behavior is not represented consistently;
- Module Federation infrastructure has no real Shell-owned mounting route;
- global search, resource detail, timeline, and media attachment have no Shell resolver or UI entry point;
- existing public component, API, search, and report descriptor slots cannot safely acquire production implementations until Codesmith and gateway support exist; and
- changing tenant context does not invalidate a broader composition because no such composition exists.

## Solution Statement

Introduce one server-resolved Shell composition boundary.

First, complete trusted context selection. Keep exactly one tenant and one active legal entity in the Shell session. Resolve legal entities from Core and authorization relationships, reject cross-tenant or inactive selections, and put the selected `legalEntityId` into `SafeAuthenticatedIdentity`, `TrustedPrincipalContext`, and every Shell-issued MicroVertical assertion. Tenant or legal-entity changes force a document reload and discard the previous composition.

Second, extend deployment-safe module contracts with validated Shell contribution descriptors. Contributions bind stable semantic Shell targets to existing page/component/API/Action/resource/search/report descriptors while executable implementations stay in the owner-local Vertical Runtime Registration. Extend Codesmith and repository checks before permitting new public component, API, search-provider, or report business artifacts.

Third, compose the Installed Module Catalog with one request-scoped tenant-state snapshot and batched permission decisions. Definite module permission denial removes an item from normal navigation and direct access returns typed `403`. Authorization-service uncertainty keeps an otherwise eligible item visible but disabled and direct access returns retryable `503`. `active`, `read_only`, and `deprecated` modules are visible; read-only/deprecated write affordances are disabled. Hidden lifecycle states produce an explanatory `404` for normal URLs, while explicitly declared `historical_read` entrypoints continue to follow the authoritative Core matrix.

Finally, add Shell-owned module, search, and resource routes. Every route validates the safe descriptor, prepares the complete request snapshot, checks state and permission, and only then invokes a lazy remote/component/provider thunk. Search, resource detail, timeline, and media attachment use the selected legal entity, generated Effect contracts and clients, typed Problem Details, explicit empty/partial/unavailable states, and resource-level authorization. No raw remote string, eager remote import, browser-supplied identity, or cross-vertical private import is permitted.

## Relevant Files

Use these files to implement the feature:

- `packages/core-runtime/src/db/schema.ts` — already owns tenants, legal entities, audit/domain events, media assets/links, and search index entries used by Shell context and cross-module foundations.
- `packages/core-runtime/src/auth/principal-resolver.ts` — resolves a BetterAuth user to trusted tenant/principal identity and is the existing pattern for context reads.
- `packages/core-runtime/src/actions/principal-context.ts` — canonical trusted context already supports an optional `legalEntityId`; Shell composition will require it for authenticated browser work.
- `packages/core-runtime/src/permissions/service.ts` — existing Effect-managed SpiceDB client lifecycle to reuse for batched module, legal-entity, and resource authorization without changing Action semantics.
- `packages/core-runtime/spicedb/bootstrap.yaml` — currently contains only Action permissions and needs tenant, legal-entity, module, and resource read relationships and assertions.
- `packages/core-runtime/src/modules/manifest.ts` — public resource/search/report/component data and serialized deployment-contract schema.
- `packages/core-runtime/src/modules/runtime-registration.ts` — owner-local executable seam and safe descriptor projection.
- `packages/core-runtime/src/modules/catalog.ts` — immutable allowlisted installed-module lookup used by composition.
- `packages/core-runtime/src/modules/module-entrypoint.ts` — canonical structured role/access/scope descriptors.
- `packages/core-runtime/src/modules/module-state-gate.ts` — single authoritative lifecycle/access matrix and request snapshot implementation.
- `packages/core-runtime/src/modules/module-entrypoint-gateway.ts` — required state, authorization, then lazy-load ordering.
- `packages/shared-contracts/src/gateway-context.ts` — typed Shell-issued trusted-context assertion contract.
- `apps/shell-super-app/api/auth/db/schema.ts` — BetterAuth session currently persists only `activeTenantId`.
- `apps/shell-super-app/api/auth/service.ts` — current session, tenant listing/switching, identity resolution, and safe session model.
- `apps/shell-super-app/api/auth/gateway-issuer.ts` — signs the trusted context sent across a MicroVertical deployment seam.
- `apps/shell-super-app/api/modules/deployment-allowlist.ts` — limits discoverable deployments.
- `apps/shell-super-app/api/modules/installed-module-catalog.ts` — fetches and validates deployment-safe contracts.
- `apps/shell-super-app/api/index.ts` — Shell BFF layer currently exposing the active-only module endpoint.
- `apps/shell-super-app/shared/api.ts` — typed Shell Effect HTTP contracts and Problem Details.
- `apps/shell-super-app/src/api/auth-client.ts` — generated Effect client adapter used by Shell route loaders and handlers.
- `apps/shell-super-app/src/api/vertical-clients.ts` — generated deployment client/remote boundary to integrate only after a gateway decision.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — authenticated server loader currently combining session, active modules, and tenants.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — authenticated home integration and context switching.
- `apps/shell-super-app/src/routes/shell-frame.tsx` — Shell layout, tenant selector, guessed module navigation, and future persistent search entry point.
- `apps/shell-super-app/src/routes/module-entrypoint-loader.ts` — existing batched state-check and lazy-load adapter.
- `scripts/scaffolding/cli.mts` — Codesmith command surface that must govern newly supported contribution categories.
- `scripts/scaffolding/module-contract/scaffold.mts` — generated manifest and private registration starting point.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — existing governed page generator to extend with Shell contribution wiring.
- `scripts/check-ontos-module-contracts.mts` — manifest/registration/contract consistency enforcement.
- `scripts/check-module-entrypoint-boundaries.mts` — structured entrypoint and private implementation boundary enforcement.
- `docs/architecture/MODULE_MANIFESTS.md` — authoritative independently deployed module-contract seam.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — authoritative tenant-state gateway and one-query composition rules.
- `docs/architecture/MICROVERTICALS.md` — strict vertical deployment seam and Effect BFF boundary.
- `docs/architecture/ERRORS.md` — typed errors and HTTP Problem Details mapping.
- `docs/frontend/FRONTEND.md` — Shell loading, empty, forbidden, unavailable, accessibility, and UI-kit rules.

### New Files

- `packages/core-runtime/src/auth/legal-entity-context.ts` — authorized legal-entity listing and exact-selection validation service.
- `packages/core-runtime/src/permissions/context-access.ts` — batched legal-entity, module, and resource read-permission adapter over the shared SpiceDB client lifecycle.
- `packages/core-runtime/src/modules/shell-contribution.ts` — exact schemas and reference validation for deployment-safe Shell contribution descriptors.
- `packages/core-runtime/tests/unit/legal-entity-context.test.ts` — legal-entity classification, tenant isolation, status, ordering, and unavailable behavior.
- `packages/core-runtime/tests/unit/context-access.test.ts` — fail-closed batch response classification and object-ID mapping tests.
- `packages/core-runtime/tests/unit/shell-contribution.test.ts` — ownership, reference, duplicate, exact-schema, and serialization tests.
- `packages/core-runtime/tests/integration/context-access.test.ts` — SpiceDB tenant/legal-entity/module/resource isolation tests.
- `apps/shell-super-app/api/modules/shell-composition.ts` — pure composition and target-resolution service.
- `apps/shell-super-app/api/resources/resource-runtime.ts` — Shell/Core resource-detail, timeline, and media affordance orchestration over typed providers and Core projections.
- `apps/shell-super-app/api/search/search-runtime.ts` — legal-entity-scoped global search orchestration and partial-result policy.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — server-side module target resolution.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — guarded MicroVertical mounting point and typed route states.
- `apps/shell-super-app/src/routes/[lang]/search/page.data.ts` — global search route integration.
- `apps/shell-super-app/src/routes/[lang]/search/page.tsx` — accessible search results and degraded states.
- `apps/shell-super-app/src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.data.ts` — resource target, timeline, and media resolution.
- `apps/shell-super-app/src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.tsx` — Shell-owned resource composition page.
- `apps/shell-super-app/tests/unit/shell-composition.test.ts` — complete composition truth table.
- `apps/shell-super-app/tests/unit/search-runtime.test.ts` — provider filtering, aggregation, and failure semantics.
- `apps/shell-super-app/tests/unit/resource-runtime.test.ts` — resource/timeline/media orchestration and authorization tests.

## Implementation Plan

### Phase 1: Foundation

Complete the trusted legal-entity context, shared authorization vocabulary, deployment-safe Shell contribution schemas, Codesmith authoring support, and static boundary checks. Extend rather than replace the existing tenant session, Installed Module Catalog, Vertical Runtime Registration, module-state snapshot, and gateway contracts.

### Phase 2: Core Implementation

Implement one pure Shell composition model and typed BFF surface. Add guarded module target loading and the Shell/Core search, resource-detail, timeline, and media orchestration boundaries. All decisions use the trusted selected legal entity, batched state/permission inputs, generated Effect clients, and declared errors.

### Phase 3: Integration

Render the complete responsive Shell using `@techsio/ui-kit`, localized copy, accessible navigation/context/status semantics, and explicit loading, empty, forbidden, not-found, unavailable, partial-result, retry, read-only, and deprecated behavior. Prove the deployment seams with synthetic module contracts and lazy provider spies, then update authoritative app documentation and run the repository gates.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Complete the trusted legal-entity context model

- [ ] Add `packages/core-runtime/src/auth/legal-entity-context.ts` as an Effect service that lists active legal entities belonging to the selected tenant and validates one exact selection. Compose it with authorization in Step 3 so a database row alone never grants access.
- [ ] Define deterministic safe view values containing only `legalEntityId` and `legalName`; reject inactive, cross-tenant, missing, duplicated, malformed, or indeterminate records with declared typed errors.
- [ ] Add unit and database integration tests beside the service for zero/one/many entities, stable ordering, tenant isolation, suspended/archived entities, and database unavailability.
- [ ] Extend `SafeAuthenticatedIdentity` and the Shell session model with a required selected legal entity for authenticated Shell composition. Add `activeLegalEntityId` to `apps/shell-super-app/api/auth/db/schema.ts`, run `mise exec -- pnpm db:generate`, inspect the generated migration, and update schema/catalog/upgrade tests before using the column.
- [ ] Preserve exactly one selection: automatically select the only authorized entity; when multiple authorized entities have no valid saved selection, return a typed selection-required Shell state; never silently continue with an invalid entity. A tenant switch clears/revalidates the entity before any new composition is returned.

### 2. Define deployment-safe Shell contribution contracts

- [ ] Add `packages/core-runtime/src/modules/shell-contribution.ts` with exact Effect schemas for semantic navigation/page, public-component, search, resource-detail, timeline, report, and media-attachment bindings. Each binding references an existing manifest key and governed `ModuleEntrypointDescriptor`; it contains no function, schema value, handler, route tree, arbitrary URL, source path, import specifier, or raw Module Federation remote string.
- [ ] Keep localized URLs and Shell-generic copy Shell-owned. Use stable semantic keys, module display metadata, declared ordering/grouping metadata only where concrete navigation reuse requires it, and validate owner module identity plus entrypoint role/access compatibility.
- [ ] Extend `VerticalRuntimeRegistration`, its WeakMap-held private values, safe descriptor extraction, manifest serialization, and Installed Module Catalog validation. Bump/reject deployment schema versions deliberately and retain all-or-nothing catalog loading.
- [ ] Add manifest, registration, catalog, and `shell-contribution.test.ts` coverage for valid empty/full contracts, exact-key rejection, missing and cross-module references, duplicates, deterministic ordering, immutability, JSON round trips, and proof that executable/private values never serialize.

### 3. Add legal-entity, module, and resource authorization foundations

- [ ] Refactor only the reusable SpiceDB client acquisition, deadline, consistency, and safe-failure mechanics from `packages/core-runtime/src/permissions/service.ts`; keep existing Action permission behavior and public types unchanged.
- [ ] Add `packages/core-runtime/src/permissions/context-access.ts` with batched interfaces for accessible legal entities, module access, and resource reads. Use tenant-qualified lossless object IDs, fully consistent decisions at authorization boundaries, and exhaustive `allowed`, `denied`, or `unavailable` outcomes.
- [ ] Extend `packages/core-runtime/spicedb/bootstrap.yaml` with tenant, legal-entity, module, and resource definitions and assertions. Legal-entity access must be tenant-isolated; module access must be evaluated for the selected tenant/legal entity; resource access must include tenant, legal entity, module, resource type, and resource ID.
- [ ] Use Authzed bulk/list-filtering APIs supported by installed `@authzed/authzed-node`. Treat missing tuples as definite denial and timeout, configuration failure, partial/malformed/duplicate/unknown responses, or conditional/indeterminate decisions as unavailable. Never turn uncertainty into visibility or access.
- [ ] Add unit and integration tests for cross-tenant/cross-entity leakage, bulk result correlation, empty batches, unavailable SpiceDB, exact resource filtering, and unchanged Action authorization.

### 4. Extend Codesmith before new contribution categories are usable

- [ ] Update the module-contract generator to emit explicit empty Shell contribution slots and keep repeat/overwrite/no-partial-write/traversal guarantees.
- [ ] Update the existing MicroVertical page generator so it atomically registers the generated page descriptor and safe Shell navigation/mount binding while preserving `appId` as deployment identity and `moduleId` as business owner identity.
- [ ] Extend Codesmith and `scripts/scaffolding/cli.mts` with governed generators for public components, module APIs, search providers, and reports before any production artifact in those categories is permitted. Each generator must reserve/patch the matching private registration and safe contribution slots atomically and generate the approved gateway/client adapter.
- [ ] Add disposable generator compile, repeat, overwrite, traversal, collision, and no-partial-write tests. Update `check-ontos-module-contracts.mts` and `check-module-entrypoint-boundaries.mts` to reject hand-authored unsupported artifact categories, raw remote loads, eager private imports, mismatched ownership, unregistered descriptors, and Shell imports of vertical private source.
- [ ] Do not generate a production MicroVertical, Action, page, provider, component, API, or report in this feature; use generator fixtures and synthetic contracts to prove the infrastructure.

### 5. Persist and expose exactly one authorized legal-entity selection

- [ ] Add exact Effect schemas and Shell BFF endpoints in `apps/shell-super-app/shared/api.ts` for listing available legal entities and switching the selected entity. Selection is Shell-owned authentication context, not a business Action.
- [ ] Resolve candidate rows through `LegalEntityContext` and filter them through `ContextAccess` before returning them. Never accept tenant, principal, authorization result, or trusted context from browser input; the switch payload contains only the requested legal-entity ID.
- [ ] Persist a validated selection on the current BetterAuth session. On login/current-session resolution, return authenticated composition only when the saved entity remains active, belongs to the active tenant, and is authorized. Clear/reject stale selections without silently selecting a different entity when several choices exist.
- [ ] Include `legalEntityId` in `SafeAuthenticatedIdentity`, the canonical `TrustedPrincipalContext`, Shell gateway assertion claims, and exact audience verifier tests. Keep credentials, cookies, session tokens, permissions, and business payloads out of the assertion.
- [ ] Map missing/invalid selection to a safe selection-required state, definite access denial to `403`, capability unavailability to retryable `503`, and unexpected defects to declared safe `500` after logging the full Effect cause.
- [ ] Add unit, integration, migration, gateway issuer/verifier, and browser tests for one/many/no accessible entities, keyboard selection, stale context, cross-tenant selection, authorization loss, tenant-switch invalidation, retry, and full document reload.

### 6. Implement the pure Shell composition model

- [ ] Add `apps/shell-super-app/api/modules/shell-composition.ts` with `compose(context)` and target resolution operations over injected Installed Module Catalog, ModuleStateGateway, and ContextAccess interfaces.
- [ ] Collect every page/component/search/resource/timeline/report/media descriptor the request may use, then prepare one exact module-state snapshot and batched permission inputs. Do not issue one state or permission request per navigation item, component, or provider.
- [ ] Produce deterministic serializable navigation and affordance models. Show `active`, `read_only`, and `deprecated` modules; mark read-only/deprecated as non-writable. Hide definite permission denials and the normal navigation for `inactive`, `suspended`, `quarantined`, and `archived` states. Keep an otherwise eligible module visible but disabled when authorization is unavailable.
- [ ] Never guess a URL. Generate an `href` only for an installed, referenced, state-allowed, permission-allowed landing target. A missing landing binding is visible as unavailable only when the module otherwise belongs in navigation.
- [ ] Return exhaustive target outcomes: `resolved`, `selection_required`, `not_found`, `forbidden`, and `unavailable`. Recheck direct targets independently of the earlier navigation response and delegate lifecycle legality, including `historical_read`, to `ModuleStateGate`.
- [ ] Add `shell-composition.test.ts` covering every lifecycle state, allowed/denied/unavailable permission, legal-entity changes, missing selections/bindings, differing `appId`/`moduleId`, no installed modules, independent lifecycles, historical reads, deterministic order, and one-batch query budgets.

### 7. Replace the active-only Shell BFF contract

- [ ] Replace the `ActiveModules` navigation dependency with exact composition, target, legal-entity, search, and resource Effect schemas in `apps/shell-super-app/shared/api.ts`. Retain compatibility only if a proven in-repository caller still needs the old endpoint; otherwise remove it and its client wrapper/tests together.
- [ ] Declare Problem Details for authentication-required `401`, permission-denied `403`, target-not-found `404`, conflict/stale selection `409` when applicable, retryable context/catalog/authorization/provider `503`, and safe internal `500` failures.
- [ ] Wire services in `apps/shell-super-app/api/index.ts` and generated Effect client adapters. Run Effects only at framework boundaries; do not add raw `fetch`, unchecked JSON, `Promise<unknown>`, manual responses, or browser-authored context.
- [ ] Return a degraded `200` composition when catalog/state/context are known and only permission checks are unavailable, preserving eligible disabled navigation. Return retryable `503` when installed catalog, tenant state, or selected legal-entity context cannot be established safely.
- [ ] Update contract, schema, API-runtime, and client tests beside each behavior and prove response HTTP status equals Problem Details `status`.

### 8. Add the guarded module mounting route

- [ ] Add the localized Shell-owned module target route under `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/`. Resolve the semantic landing target server-side before passing an approved descriptor and lazy thunk to `module-entrypoint-loader.ts`.
- [ ] Preserve the exact order: installed contract/reference validation, trusted selected context, batched module-state decision, module permission authorization, then lazy Module Federation load. Loader/provider spies must prove no remote code executes for selection-required, `404`, `403`, or `503` outcomes.
- [ ] Render localized explanatory not-found, forbidden, unavailable/retry, and authorized-remote-load-failure states. State/permission changes between navigation and direct resolution must fail closed on the target request.
- [ ] Update route generation/metadata and add unit/integration/browser tests for SSR, localized URLs, direct navigation, refresh, keyboard focus, state changes, retry, remote failure, and `appId`/`moduleId` separation.

### 9. Integrate state-aware navigation and context selectors

- [ ] Replace module-key props in `shell-frame.tsx` with the composed navigation model. Render only allowed links; omit definite permission denials; render authorization-unavailable modules as non-interactive semantic content with an unavailable status and retry; show UI-kit status badges for `read_only` and `deprecated`.
- [ ] Add the legal-entity selector beside the existing tenant selector using installed `@techsio/ui-kit` components and the same semantic callback pattern. Disable both selectors during their own mutation, announce failures, retain the last verified context, and fully reload after a successful change.
- [ ] Keep exactly one selected legal entity visible throughout the authenticated Shell. If selection is required, render the context-selection state before module navigation or mounting; if none are accessible, render an access-blocked state.
- [ ] Update both `cs` and `en` Shell catalogs and component/browser tests for accessible labels, status announcements, keyboard order, `aria-current`, focus behavior, narrow screens, no horizontal overflow, pending/failure/retry, and tenant-to-entity invalidation.

### 10. Add legal-entity-scoped global search

- [ ] Keep a persistent Shell-owned search landmark in the authenticated layout and add the localized search route. Resolve eligible providers only from safe installed contributions after context, lifecycle, and permission filtering.
- [ ] Scope candidate selection to the active tenant and selected legal entity. Invoke provider operations only through their generated Effect BFF clients/gateways, then apply resource-level SpiceDB list/bulk authorization before returning results.
- [ ] Aggregate results into one stable ResourceRef-shaped result contract. Zero eligible providers or zero authorized results is a successful empty state. If at least one provider succeeds, return its results plus an announced partial-result warning for failed providers; if all eligible providers fail, return retryable `503`.
- [ ] Link results only to the Shell-owned resource route. Record denied read/search evidence through the established Core data-access evidence boundary when that runtime exists; do not log queries, result payloads, or private provider details as telemetry.
- [ ] Add unit, BFF integration, component, and browser tests for empty query, zero providers, denied/hidden/unavailable providers, mixed success, all-provider failure, malformed results, selected-entity isolation, resource filtering, cancellation/debouncing supported by the chosen UI-kit integration, and retry.

### 11. Add Shell-owned resource detail and timeline composition

- [ ] Add the localized ResourceRef route under `apps/shell-super-app/src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/`. Validate the module/resource type against the Installed Module Catalog and selected tenant/legal entity before invoking an owner provider through its generated Effect client.
- [ ] Apply an explicit resource permission check before returning detail. Unknown/uninstalled resources or absent detail bindings return explanatory `404` when safe; definite permission denial returns `403`; context/state/provider uncertainty returns retryable `503`.
- [ ] Compose timeline entries only after resource authorization. Use declared timeline providers and/or Core audit/domain projection adapters without treating Neo4j as canonical. No eligible events is a successful empty timeline; projection lag is represented explicitly; provider failure is typed and retryable.
- [ ] Keep reusable presentation props plain and map provider success/errors to loading, empty, forbidden, not-found, unavailable, partial/lagging, and retry view models in route/feature integration.
- [ ] Add unit, integration, and browser tests for cross-tenant/entity ResourceRefs, missing resources, denied reads, no timeline, mixed provider events, deterministic ordering, projection lag, malformed provider data, stale context, narrow layouts, and remote/provider failure before and after authorization.

### 12. Add media attachment entry points

- [ ] Derive media capability from the resource type's `mediaAttachable` descriptor, a generated declared media Action/API binding, active selected context, resource permission, module state, and write authorization. A descriptor is discoverability only and never grants permission.
- [ ] Render media listing/attachment entry points on the Shell resource page. Disable mutation with an accessible explanation when the capability is absent, denied, temporarily unavailable, `read_only`, or `deprecated`.
- [ ] Execute uploads/links only through declared typed Core/MicroVertical Effects and generated Actions; preserve object-storage identity, typed media metadata, ResourceRef link, audit/evidence, and Action transaction rules. Do not write `media_assets` or `media_links` from presentation or another MicroVertical.
- [ ] Represent upload validation, progress, cancellation, scanning/processing, success, conflict, unavailable, and retry states using the installed UI kit and localized copy. Never expose storage keys, credentials, scanner diagnostics, or unsafe filenames.
- [ ] Add unit/integration/browser tests for absent capability, read-only/deprecated state, forbidden resource, authorization outage, invalid type/size, upload failure/cancel/retry, successful link to the exact ResourceRef and selected legal entity, duplicate/conflict behavior, and no mutation when the gate fails.

### 13. Document and statically enforce the completed Shell boundary

- [ ] Update `MODULE_MANIFESTS.md` to distinguish authored public descriptors, owner-local executable registration, safe serialized Shell contributions, and the Shell Installed Module Catalog. Keep arbitrary routes/imports/private implementations forbidden.
- [ ] Update `MODULE_ENTRYPOINTS.md` with context selection, composition query budgets, direct-target rechecks, load ordering, lifecycle/permission outcome table, and search/resource/timeline/media behavior.
- [ ] Update `MICROVERTICALS.md`, `ERRORS.md`, and `FRONTEND.md` only where the completed behavior adds a concrete rule. Update `README.md` with new generator/validation commands. Keep `app/docs` authoritative and record conflicting older repository-level static-registry wording as a follow-up rather than implementing it.
- [ ] Add repository boundary fixtures proving Shell/Core never statically imports a production vertical manifest, private registration, route, provider, handler, repository, database module, or raw remote string.

### 14. Run the complete validation suite

- [ ] From `app/`, execute every command in `Validation Commands` in order. Fix only regressions caused by this feature, verify generated migrations/contracts/routes are current, and finish with the complete repository quality gate.

## Testing Strategy

### Unit Tests

Use exact-schema and pure-policy tests for legal-entity classification, session selection, context-access batch decisions, safe Shell contributions, catalog projection, navigation/affordance composition, URL generation, state/permission truth tables, search aggregation, resource/timeline orchestration, and media availability. UI tests cover accessible context selection, linked versus unavailable navigation, status badges, persistent search, empty/forbidden/not-found/unavailable/retry states, and responsive layout. Lazy thunk spies prove private implementations never load before all applicable gates pass.

### Integration Tests

Use Postgres integration tests for legal-entity tenant/status isolation and session migration behavior. Use the local SpiceDB bootstrap for legal-entity, module, and resource permission isolation. Exercise Shell Effect BFFs through generated clients for selection, composition, direct target resolution, search, resources, timelines, and media errors. Exercise Codesmith and boundary scripts only against disposable synthetic workspaces. Browser tests prove SSR-visible composition, legal-entity switching, tenant invalidation, direct URLs, remote retry, search and resource routes, and disabled write affordances without requiring a production MicroVertical.

### Edge Cases

- The user has no authorized legal entity, exactly one, or several with no saved selection.
- The saved legal entity is removed, suspended, archived, moved to another tenant, or loses permission between requests.
- Tenant switching invalidates the selected legal entity and every prior composition/target decision.
- The deployment allowlist is empty, malformed, timed out, oversized, or returns an unsupported contract version.
- `appId` differs from `moduleId`, duplicate deployments claim one module, or a contribution references another module's descriptor.
- Module state or permission changes after navigation composition but before target resolution or mutation.
- A denied module is absent from navigation, while an authorization outage leaves an otherwise eligible module visible but disabled.
- A visible module has no valid landing target, or a remote loader fails only after all gates pass.
- An explicit historical read is allowed in a lifecycle state where normal read/navigation is hidden.
- Search has zero providers, no authorized results, partial provider success, total provider failure, or invalid ResourceRefs.
- Resource detail has no timeline provider/events, lagging projections, conflicting providers, or a denied target.
- Media is absent, read-only, deprecated, denied, unavailable, canceled, scanning, conflicted, or linked concurrently.
- Keyboard-only, screen-reader, narrow-viewport, reduced-motion, and slow-network use remain understandable and operable.

## Acceptance Criteria

- [ ] Every authenticated Shell composition has exactly one verified active tenant and one verified active legal entity; no tenant-wide “All legal entities” context exists.
- [ ] The selected legal entity is persisted, switchable, carried in trusted gateway context, and revalidated independently at every trust boundary.
- [ ] Tenant/legal-entity changes invalidate and fully recompute navigation, module state, permissions, search providers/results, resource targets, timelines, and media affordances.
- [ ] The Shell derives navigation only from allowlisted installed contracts and validated safe contribution descriptors; it never guesses `/${moduleKey}` routes.
- [ ] `active`, `read_only`, and `deprecated` modules are visible; read-only/deprecated writes are disabled; hidden lifecycle states are absent from normal navigation.
- [ ] Definite permission denials are absent from navigation and produce typed `403` on direct access; temporary permission uncertainty remains visible but disabled and produces retryable `503`.
- [ ] Unknown/uninstalled targets and normal URLs for hidden lifecycle states produce an explanatory localized `404` without loading remote code.
- [ ] Each Shell/page composition performs at most one batched tenant-state acquisition for all declared tenant entrypoints and batched permission work rather than per-component checks.
- [ ] Every page, component, provider, report, resource, timeline, and media target is validated, state-checked, and authorized before its lazy implementation or BFF operation runs.
- [ ] Global search is always available as a Shell entry point, scoped to the selected legal entity, resource-authorized, empty-successful with no eligible result, and explicit about partial or total provider failure.
- [ ] Resource detail, timeline, and media attachment have Shell-owned localized routes/view states and preserve module ownership, ResourceRef, authorization, Effect, Action, audit/evidence, and deployment seams.
- [ ] Codesmith owns initial wiring for every supported business entrypoint category, and repository checks reject hand-authored or unregistered bypasses.
- [ ] No executable registration, private route/provider/handler, arbitrary remote path/import, credential, or permission decision crosses the serialized deployment contract.
- [ ] All BFF operations use exact Effect schemas, generated clients, exhaustive typed errors, and Problem Details whose body status matches the HTTP status.
- [ ] Loading, empty, selection-required, access-blocked, forbidden, not-found, unavailable, partial, retry, read-only, deprecated, validation, conflict, progress, and success states are localized, accessible, responsive, and tested as applicable.
- [ ] The complete infrastructure is proven with synthetic contracts/providers and lazy spies without creating a production business MicroVertical or bypassing a mandatory generator.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — Type-check Codesmith generators and their shared planning utilities.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — Run generator compile, mutation, repeat, traversal, and no-partial-write tests.
- `mise exec -- node --test scripts/tests/*.test.mts` — Run module-entrypoint and generated-artifact boundary tests.
- `mise exec -- pnpm --filter @app/shared-contracts test:unit` — Validate trusted gateway context contracts.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Protect existing Action definitions, permission behavior, and runtime ordering.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Run Core unit/integration coverage for context, permissions, module state, media/search schema, and database behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Run Shell contracts, composition, route, view-model, accessibility, and component tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — Run generated-client BFF and persistence integration tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — Run authenticated context, navigation, module, search, resource, timeline, media, and retry browser scenarios.
- `mise exec -- pnpm db:verify` — Verify Core and Shell Drizzle schemas against the migrated database.
- `mise exec -- pnpm mf:types` — Verify generated Module Federation type contracts.
- `mise exec -- pnpm i18n:boundaries` — Validate localized Shell and MicroVertical ownership.
- `mise exec -- pnpm api:check` — Validate strict generated Effect API topology.
- `mise exec -- pnpm module-entrypoints:check` — Enforce structured gateway and lazy-load boundaries.
- `mise exec -- pnpm check:module-contracts` — Validate authored manifests, registrations, deployment contracts, and safe contribution references.
- `mise exec -- pnpm contract:check` — Validate generated topology, route, ownership, and workspace contracts.
- `mise exec -- pnpm typecheck` — Type-check every app/package project with the repository toolchain.
- `mise exec -- pnpm build` — Build Shell, shared packages, Module Federation types, and performance readiness artifacts.
- `git diff --check` — Reject whitespace errors and malformed patches.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

- Implemented the trusted legal-entity context, shared SpiceDB access adapter, exact schema-v2 Shell contributions, owner-local runtime registration, and governed Codesmith generators.
- Replaced raw active-module discovery with typed composition, direct-target resolution, search, resource detail, timeline, and media-affordance BFF contracts and generated clients. Added localized Shell navigation, selection, search, guarded module mounting, and ResourceRef routes.
- Added unit, integration, and browser coverage for context isolation, composition lifecycle/permission outcomes, no-load-before-gate ordering, partial search, resource authorization, timelines, tenant/legal-entity switching, and generated artifact boundaries.
- Passed generator compilation/tests (31 scaffolding and 13 boundary tests), shared-contract and Action unit suites, the complete Shell unit suite (101 tests), Shell integration (3 tests), browser E2E (11 tests), Module Federation types, build, and whitespace validation.
- Reconciled the pre-existing local baseline without discarding data: removed generated-only ignored Auth/Testing vertical residue from workspace discovery, stamped already-materialized Core/Auth migrations, restored the tracked pre-auth Action and Domain Event schema details, and preserved retired Core/Ticketing tables and migration ledgers under dated `public.__legacy_*` names.
- Passed `mise exec -- pnpm db:verify`, the complete database suite (160 Core tests and 3 Shell integration tests) against the repository-pinned SpiceDB bootstrap on isolated port 50052 because an unrelated local service owns 50051, and the unchanged final `mise exec -- pnpm check` gate including formatting, lint, typecheck, skills, i18n, API, module-entrypoint, module-contract, topology-contract, and performance-readiness checks.

## Notes

- This specification supersedes `specs/feature-module-aware-shell-composition.md` for implementation planning. Do not implement both plans independently; this plan retains its valid guarded-composition work, changes definite permission denial to hidden navigation, and adds the required legal-entity context.
- The plan targets only the current `develop` branch and was researched with a clean worktree on 2026-08-07.
- “Exactly one legal entity” means one concrete active authorized `legalEntityId` for ordinary authenticated Shell work. Tenant-wide aggregate behavior requires a future explicitly scoped and authorized entrypoint; it is not represented by an “All” selector.
- The conservative default is to auto-select when exactly one entity is available and require selection when several are available without a valid saved value. This is an implementation detail, not an unresolved architecture decision.
- App-local module-manifest guidance is authoritative over older repository docs that describe static registration or joint deployment. Repository-level docs may be reconciled separately.
- Current topology installs no production business vertical. Synthetic contracts/provider adapters are therefore the correct infrastructure proof; production module proof depends on a separately generated and installed MicroVertical.
- Public components, module APIs, search providers, and reports are presently reserved but blocked by repository checks. Step 4 must land their approved Codesmith/gateway support before any production implementation in those categories.
- Timeline composition must not make Neo4j canonical. Postgres-owned audit/domain data and rebuildable projections remain authoritative according to the documented consistency model.
- `@techsio/ui-kit` installed declarations and current Shell adapter patterns are authoritative during implementation. No `libs/ui` component work is included.
- Search partial-success behavior is fixed: return successful authorized results with an announced warning when at least one provider succeeds; return retryable failure only when all eligible providers fail.
