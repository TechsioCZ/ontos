---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 02 MicroVertical foundation

## Feature Description

Implement ticket 2, "Create the CRM MicroVertical foundation," from `app/tickets.md`. Generate the
independently deployable `crm` UltraModern.js application, its `crm.core` OntOS module contract,
Shell assertion boundary, empty Customers and Deals pages, English/Czech catalogs, owner-local CRM
database lifecycle, and approved generated resource-detail/timeline contribution seam. Do not add
Customer, Contact, Deal, Offer, or Activity tables or business behavior in this ticket.

## User Story

As an OntOS implementer
I want a generated, independently deployable CRM module foundation
So that each later CRM leaf can add one bounded capability without reopening deployment, identity, persistence, page, or provider architecture

## Problem Statement

`verticals/*` is currently empty. CRM needs a topology-backed deployment, a distinct dotted business
module identity, owner-local database/migration boundary, generated public/private module pairing,
and generated entrypoints before business artifacts can be implemented safely. The current
repository also has no generator for Shell resource-detail/timeline contribution bindings.

## Solution Statement

Use the pinned UltraModern generator, then immediately run the module-contract generator before any
business generator. Generate the two private pages and the Shell-user operation identity boundary.
Add the approved Codesmith resource-provider category with atomic manifest/registration patching,
then generate Customer, Contact, and Deal detail provider entrypoints plus the Customer timeline
provider entrypoint. Establish the CRM-owned `crm` schema connection, migration journal, grant and
verification orchestration with no entity tables yet.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative identities, persistence boundary, pages, resources, and non-goals.
- `tickets.md` — corresponding ticket 2 and acceptance criteria; blockers: none.
- `README.md` — pinned workspace/vertical toolchain and direct strict Effect topology.
- `package.json` — root scripts, database orchestration, and generator command catalog.
- `pnpm-workspace.yaml` — generated vertical workspace membership and pinned cohort.
- `scripts/scaffolding/module-contract/scaffold.mts` — mandatory manifest/registration starting point.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — mandatory localized private page starting point.
- `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` — audience-scoped operation gateway/verifier.
- `scripts/scaffolding/governed-contribution/scaffold.mts` — existing governed API patterns to reuse.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — generator safety and compilation fixtures.
- `scripts/verify-application-db-schema.mts` — exact multi-owner application schema verification.
- `topology/reference-topology.json` — generated CRM deployment and remote identity.
- `topology/ownership.json` — generated CRM source ownership.
- `topology/local-overlays/development.json` — CRM development URLs and module-contract allowlist.
- `docs/architecture/MODULE_MANIFESTS.md` — mandatory `appId`/`moduleId` separation and generator order.
- `docs/frontend/FRONTEND.md` — localization, private page, and UI boundary rules.

### New Files

- `verticals/crm/**` — generated UltraModern CRM deployment and owner-local foundation.
- `scripts/scaffolding/resource-provider/scaffold.mts` — approved Codesmith category for detail/timeline provider entrypoints.
- `verticals/crm/src/db/**` — manually authored owner-local CRM database configuration/client and empty schema catalog.
- `verticals/crm/drizzle/**` — CRM-specific migration journal/output generated from the typed schema.

## Implementation Plan

### Phase 1: Foundation

Generate the vertical and its module contract in the mandated order, then generate pages and the
operation identity boundary. Preserve `appId = crm` for deployment/audience and `moduleId = crm.core`
for business ownership.

### Phase 2: Core Implementation

Add the resource-provider Codesmith category and the CRM database owner boundary. Keep the typed
schema empty of CRM entities while proving schema ownership, configuration failures, runtime-role
grants, and independent migration history.

### Phase 3: Integration

Allowlist CRM in Shell/topology, expose only safe generated descriptors and page components, add
owner-local `en`/`cs` catalogs and package test/database scripts, and verify independent build and
immutable module-contract output.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the CRM deployment and module contract

- [x] From `app/`, run `mise exec -- pnpm dlx @bleedingdev/modern-js-create@3.5.0-ultramodern.96 crm --vertical`; review only generated `verticals/crm`, topology/ownership, Shell remote wiring, workspace metadata, and lockfile changes.
- [x] Immediately run `mise exec -- pnpm scaffold:module-contract -- --vertical crm --module crm.core` before any other CRM business generator.
- [x] Set the owner-authored module display name/description to CRM while preserving the generated history-aware lifecycle and the exact `crm`/`crm.core` identity split.

### 2. Generate page and identity foundations

- [x] Run `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customers` and `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page deals`; retain private, non-indexable route metadata and generated lazy registrations.
- [x] Run `mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical crm` exactly once so later Action and governed-read attempts verify/obtain fresh assertions for audience `crm`.
- [x] Replace only generated starter copy with complete page-shell/loading/unavailable namespace foundations in both `verticals/crm/locales/en/` and `verticals/crm/locales/cs/`; add no business forms or entities.

### 3. Add and run the approved resource-provider scaffold

- [x] Extend `scripts/scaffolding/cli.mts`, `package.json`, `scripts/scaffolding/shared.mts`, and a new `scripts/scaffolding/resource-provider/scaffold.mts` with the exact usage `pnpm scaffold:resource-provider -- --vertical <vertical> --resource <resource> --surface <detail|timeline>`.
- [x] Generate a governed read descriptor/API/client/server starting point, a safe manifest resource or shell contribution descriptor, and an owner-private lazy registration; reject unsupported timeline resources, cross-owner IDs, traversal, collisions, unstable reruns, and partial writes. Generate no business provider implementation.
- [x] Add disposable fixture tests for help, detail/timeline output, same-owner composition, rerun, ordering, safe serialization, private lazy binding, compilation, and browser-surface isolation.
- [x] Run the new scaffold for Customer, Contact, and Deal detail surfaces and the Customer timeline surface. Declare public resource types exactly `crm.core.customer`, `crm.core.contact`, and `crm.core.deal`; Offer and Activity remain addressable child records, not public ResourceRefs.

### 4. Establish the empty CRM database owner boundary

- [x] Manually author CRM-local configuration, scoped pool/layer, typed Drizzle catalog, Drizzle config, schema verification, and runtime-grant integration under `verticals/crm`; use schema `crm`, output `verticals/crm/drizzle`, journal `drizzle.__drizzle_migrations_crm`, `DATABASE_ADMIN_URL` for migration/verification, and non-superuser `DATABASE_URL` for runtime with no fallback.
- [x] Add CRM to root `db:generate`, `db:migrate`, `db:test`, runtime-role bootstrap, and `scripts/verify-application-db-schema.mts` orchestration without registering CRM tables in Core/Auth catalogs or weakening their exact inventories.
- [x] Add package scripts following existing conventions: `db:generate`, `db:migrate`, `db:verify`, `test:unit`, `test:integration`, and generated `typecheck`; add foundation tests for typed config errors, scope cleanup, schema/journal ownership, runtime role restrictions, and cross-owner import rejection.

### 5. Complete Shell and deployment integration

- [x] Verify generated Shell Module Federation remote/client wiring, development overlay contract URL/port, topology `appId`, ownership paths, package exports, immutable module contract, and no Shell/Core static import of `vertical.manifest.ts` or `vertical.registration.ts`.
- [x] Add contract tests proving private pages/providers/handlers are not serialized, CRM is independently buildable, the module contract is allowlisted/discoverable, and English/Czech exports resolve owner-locally.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate. Database-backed validation used isolated local PostgreSQL and SpiceDB instances.

## Testing Strategy

### Unit Tests

Test new resource-provider generator safety/output, CRM database configuration errors, module
identity, safe manifest descriptors, localization catalogs, and private registration opacity.

### Integration Tests

Exercise generated module-contract discovery, Shell remote allowlisting, operation assertion
audience `crm`, empty CRM schema migration/grants/verification, runtime-role restrictions, and
independent vertical build/contract serialization.

### Edge Cases

- A second module contract attempts to reuse `crm.core`.
- Resource provider generation targets an undeclared/foreign resource or reruns after owner edits.
- Runtime and admin URLs are missing, identical, malformed, or use an over-privileged runtime role.
- The generated contract URL is unavailable or returns a mismatched app/module identity.

## Acceptance Criteria

- [x] `verticals/crm` independently builds and publishes a valid immutable `crm.core` module contract.
- [x] CRM has an owner-local schema/migration/grant/verification boundary but no CRM entity tables yet.
- [x] Customers and Deals pages, operation identity boundary, and resource-detail/timeline provider entrypoints are generated and governed.
- [x] CRM is allowlisted and discoverable without private cross-deployment imports.
- [x] English/Czech catalogs and focused unit/integration/database scripts are ready for later leaves.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the new provider scaffold.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — validate all generator composition and safety.
- `mise exec -- pnpm db:generate` — generate deterministic Core, Auth, and empty CRM migrations.
- `mise exec -- pnpm db:migrate` — apply independent histories and runtime grants.
- `mise exec -- pnpm db:verify` — verify exact owner catalogs and roles.
- `mise exec -- pnpm db:test` — run orchestrated database/isolation tests including CRM.
- `mise exec -- pnpm i18n:boundaries` — validate owner-local English/Czech catalogs.
- `mise exec -- pnpm module-entrypoints:check` — validate generated CRM pages/providers and private bindings.
- `mise exec -- pnpm check:module-contracts` — validate CRM identity, registration, serialization, and allowlist.
- `mise exec -- pnpm contract:check` — validate the UltraModern deployment topology.
- `mise exec -- pnpm build` — prove independent CRM and Shell builds plus MF types.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Added the independently deployable `crm` UltraModern application and immutable `crm.core` module contract.
- Added generated Customers and Deals pages, the action-principal boundary, governed detail/timeline provider seams, owner-local English/Czech catalogs, and the empty CRM database owner boundary.
- Integrated CRM with Shell discovery, topology, Module Federation, database orchestration, release packaging, and the workspace quality gates.
- Hardened generated production packages so transitive backend dependencies are materialized and the root discovery endpoint remains exempt from locale redirects.

### Changed Files

- `verticals/crm/**` — CRM application, module registration, generated contribution seams, localization, database boundary, migration metadata, tests, and deployment output configuration.
- `apps/shell-super-app/**`, `topology/**`, and workspace metadata — CRM remote discovery, allowlisting, topology ownership, and integration coverage.
- `scripts/scaffolding/**` — resource-provider generator plus module-contract/action-boundary production-hardening and generator tests.
- `scripts/**`, `package.json`, `pnpm-lock.yaml`, and `zerops.yaml` — database orchestration, contract checks, deploy packaging, and runtime materialization.

### Tests

- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — 26/26 tests passed.
- `mise exec -- pnpm --filter @app/crm test:unit` — 12/12 tests passed.
- `mise exec -- node --test apps/shell-super-app/tests/integration/crm-module-discovery.test.ts` — 3/3 tests passed.
- `mise exec -- pnpm db:test` — Core, Auth, CRM, PostgreSQL isolation, and SpiceDB-backed suites passed; CRM database integration passed 1/1.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json`
- `mise exec -- pnpm db:generate`
- `mise exec -- pnpm db:migrate`
- `mise exec -- pnpm db:verify` — verified Core 18 tables, Auth 6 tables, and the intentionally empty CRM catalog.
- `mise exec -- pnpm i18n:boundaries`
- `mise exec -- pnpm module-entrypoints:check`
- `mise exec -- pnpm check:module-contracts`
- `mise exec -- pnpm contract:check`
- `NODE_OPTIONS=--max-old-space-size=8192 mise exec -- pnpm build` — clean CRM and Shell production builds, deploy materialization, Module Federation types, and performance readiness passed.
- `mise exec -- pnpm check` — final repository quality gate passed.
- Built CRM production runtime returned HTTP 200 for `/en/customers` and `/cs/deals`; browser snapshots contained the localized page/empty-state copy with no console errors.
- `/.well-known/ontos-module-manifest.json` returned HTTP 200 directly, with no redirect, `application/json`, schema version `2`, and module id `crm.core`.
- The deployed CRM package contains `@authzed/authzed-node`, and the production Effect BFF starts without unresolved runtime dependencies.

### Review

- Reviewed the implementation against this plan, `tickets.md`, the CRM master specification, `AGENTS.md`, app-local architecture guidance, frontend guidance, module-manifest rules, and topology contracts.
- Confirmed all changes stay under `app/`, preserve the `crm`/`crm.core` identity split, expose only safe descriptors, and add no CRM business entities or behavior.
- Confirmed generated categories were created through the mandatory Codesmith generators and their safety/compilation fixtures cover reruns and future generated verticals.

### Deviations

- No product-scope deviations. Database validation used disposable isolated PostgreSQL and SpiceDB containers on alternate local ports to avoid depending on stale shared development state.

## Notes

- Dependency: none; ticket 2 may run in parallel with ticket 1, but do not run its generators concurrently with another generator/migration task in one working tree.
- The resource-provider generator is the approved prerequisite named by the CRM master spec; no resource/timeline business provider may be hand-authored before it exists.
- No Action, Policy, Outbox Message, entity table, search provider, search control, or search behavior is created here.
- App-local architecture overrides older repository-level jointly deployed MicroVertical documentation.
