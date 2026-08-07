---
type: chore
status: done
created: 2026-08-07
---

# Chore: Remove module dependencies from the OntOS lifecycle contract

## Chore Description

Simplify the OntOS Module Manifest, installed-module catalog, and tenant module-state transition path so every business module is installed and managed independently. Remove dependency declarations for Core capabilities, external systems, and other business modules; remove all four dependency modes and the dependency graph; and remove dependency-aware activation validation from the Core state-change Action.

Core capabilities are universal platform infrastructure rather than per-module manifest requirements. External-system readiness and module-owned configuration are private implementation concerns and do not participate in V0 activation. Business modules may still communicate through the existing typed public API, public event, and Outbox seams, but those references never create installation, activation, deactivation, setup, or transition prerequisites.

Keep the existing tenant activation states, per-manifest `supportedStates`, installed-catalog membership check, universal module-state entrypoint gate, and state persistence/history behavior. V0 does not add activation plans, activation bundles, reverse-dependency checks, setup validation, or a state-transition graph: an administrator may request any state that the installed module declares as supported.

## Relevant Files

Use these files to accomplish the chore:

- `packages/core-runtime/src/modules/manifest.ts` — owns the authored and serialized manifest schemas, dependency vocabulary, and deployment-contract version.
- `packages/core-runtime/src/modules/catalog.ts` — currently constructs and validates the installed dependency graph and requires referenced Outbox producers to be installed.
- `packages/core-runtime/src/modules/tenant-module-state-service.ts` — currently reads the tenant-wide state snapshot and rejects inactive `must_be_active_first` dependencies.
- `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts` — currently loads dependency state, records dependency-snapshot evidence, and exposes the dependency failure.
- `packages/core-runtime/src/modules/tenant-module-state-errors.ts` — owns the dependency-inactive typed error that becomes obsolete.
- `packages/core-runtime/src/index.ts` — exports the dependency schemas, types, and lifecycle error publicly.
- `packages/core-runtime/tests/unit/module-manifest.test.ts` — validates exact authored and serialized manifest shapes and contract versions.
- `packages/core-runtime/tests/unit/module-catalog.test.ts` — currently tests missing, self, and cyclic dependency rejection alongside catalog invariants.
- `packages/core-runtime/tests/unit/tenant-module-state.test.ts` — currently tests active-first transition rejection and the dependency error contract.
- `packages/core-runtime/tests/unit/module-state-gate.test.ts` — contains `TenantModuleStateService` fakes that must follow the reduced service interface without changing gate behavior.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — contains serialized installed-module fixtures that must use the simplified contract version.
- `packages/core-runtime/tests/integration/tenant-module-state.test.ts` — proves transactional state changes and currently asserts dependency rejection and dependency-snapshot evidence.
- `scripts/scaffolding/module-contract/scaffold.mts` — generates the authored manifest starter and records the deployment-contract schema version in package metadata.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` — validates generated owner files, package metadata, and deterministic serialized artifacts.
- `scripts/generate-ontos-module-contract.mts` — currently copies authored dependency metadata into the serialized deployment contract.
- `scripts/check-ontos-module-contracts.mts` — validates generated module owner slots and deployment contracts against the exact schema.
- `apps/shell-super-app/tests/unit/installed-module-catalog.test.ts` — tests remote contract loading and catalog aggregation using serialized fixtures.
- `apps/shell-super-app/tests/unit/installed-outbox-matcher.test.ts` — tests the safe Outbox subscription snapshot using serialized fixtures.
- `apps/shell-super-app/tests/integration/module-catalog-runtime.test.ts` — proves deployment discovery and owner-local runtime separation and currently authors an optional module dependency.
- `docs/architecture/MODULE_MANIFESTS.md` — currently documents dependencies as serialized manifest data and catalog validity requirements.
- `specs/feature-module-aware-shell-composition.md` — currently plans Shell dependency evaluation and must not reintroduce the removed dependency model.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Simplify and version the module manifest contract

- [x] In `packages/core-runtime/src/modules/manifest.ts`, remove `OntosModuleDependencyModeSchema`, `OntosModuleDependencySchema`, `OntosModuleDependenciesSchema`, `OntosCoreCapabilitySchema`, `OntosExternalSystemDependencySchema`, and their exported types.
- [x] Remove `dependencies` from `OntosModuleManifestInput`, `OntosSerializedModuleManifestSchema`, `defineOntosModuleManifest` exact-key validation, duplicate/self-reference validation, freezing, and the resulting authored manifest value. The remaining top-level manifest interface is exactly `activation`, `module`, and `publicSurface`.
- [x] Bump `ONTOS_MODULE_CONTRACT_SCHEMA_VERSION` from `0` to `1` because removing a required serialized field is a breaking deployment-contract change. Continue to reject every unsupported or legacy contract version rather than accepting ambiguous mixed catalogs.
- [x] Update `packages/core-runtime/src/index.ts` so none of the removed dependency schemas or types remain public.
- [x] Update `packages/core-runtime/tests/unit/module-manifest.test.ts` beside the contract change: prove the simplified authored value remains exact, inferred, and frozen; prove an authored or serialized `dependencies` property is rejected as excess data; prove schema version `1` succeeds; and prove version `0` and unknown future versions fail.

### 2. Remove dependency and installation coupling from the catalog

- [x] In `packages/core-runtime/src/modules/catalog.ts`, delete required-dependency extraction and `must_be_active_first` cycle traversal. Preserve exact contract decoding, allowlisted `appId` matching, one business module per deployment, duplicate app/module rejection, deterministic dual indexes, immutability, and all-or-nothing catalog construction.
- [x] Stop requiring an Outbox subscription's `producerModuleKey` to be present in the installed catalog. Keep validation that the consumer and structured worker entrypoint belong to the declaring module and that worker keys are unique. An absent producer leaves the independent consumer subscription dormant; it does not invalidate installation or activation.
- [x] Refactor `packages/core-runtime/tests/unit/module-catalog.test.ts` fixtures to the version `1` dependency-free shape. Remove graph-specific cases and replace them with regression coverage proving independently installed modules aggregate without relationship metadata and a valid owner-local subscription may reference a producer that is not installed.
- [x] Keep negative tests for malformed versions, deployment mismatch, duplicate identities, mismatched consumer ownership/entrypoints, and duplicate worker keys so simplification does not weaken unrelated catalog safety.

### 3. Reduce tenant module-state changes to target-module validation

- [x] Simplify `validateTenantModuleStateTransition` in `packages/core-runtime/src/modules/tenant-module-state-service.ts` so it accepts only the installed catalog, target `moduleKey`, and requested state. Preserve the current stale-row cleanup behavior that permits changing an unknown module to `inactive`; for every other state, require an installed module and a manifest-supported target state.
- [x] Remove `listTenantModuleStatesForTransition` from `TenantModuleStateServiceShape` and its implementation because no lifecycle operation needs a tenant-wide state snapshot. Keep the existing targeted and list read methods used by the universal state gate and Shell.
- [x] Remove `TenantModuleStateDependencyInactiveError` from `packages/core-runtime/src/modules/tenant-module-state-errors.ts`, the Action error union, public exports, and all tests. Retain the typed catalog/validation-unavailable error because loading the authoritative installed catalog can still fail.
- [x] In `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts`, remove the tenant-wide dependency-state read and its `tenant-module-state-dependency-snapshot` data-access evidence. Load the installed catalog, validate the target module/state, then use the existing transactional persistence path and its concurrency, history, audit, and prior-state evidence.
- [x] Update `packages/core-runtime/tests/unit/tenant-module-state.test.ts` to prove unknown non-inactive modules and unsupported target states still fail, stale unknown modules can still become inactive, and no dependency vocabulary remains in the error contract.
- [x] Update `packages/core-runtime/tests/integration/tenant-module-state.test.ts` to remove dependency setup/rejection cases and prove one installed module can enter every declared supported state regardless of other installed modules' tenant states. Assert successful changes now record only the prior-state access evidence and preserve atomic state/history/action/audit behavior.
- [x] Remove the obsolete service method from fakes in `packages/core-runtime/tests/unit/module-state-gate.test.ts` and other affected tests without changing the established module-state access matrix, batching, fail-closed behavior, or transaction-aware Action recheck.

### 4. Update Codesmith and serialized artifact generation

- [x] In `scripts/scaffolding/module-contract/scaffold.mts`, stop generating a `dependencies` block. Keep the conservative activation defaults, module identity, empty public surfaces, runtime registration owner slots, and `@app/core-runtime` package dependency needed to author the manifest.
- [x] Change generated `modernjs.ontosModule.schemaVersion` metadata from `0` to `1`, keeping it aligned with `ONTOS_MODULE_CONTRACT_SCHEMA_VERSION` and the generated artifact.
- [x] In `scripts/generate-ontos-module-contract.mts`, stop reading or serializing `owner.manifest.dependencies`; emit only deployment identity, simplified manifest data, safe runtime descriptors, and schema version `1`.
- [x] Update `scripts/scaffolding/tests/module-contract-generator.test.mts` to prove fresh output contains no dependency block or Core/external/module dependency strings, package metadata records version `1`, emitted JSON is deterministic and dependency-free, and damaged owner slots or incompatible contract versions still fail without partial writes.
- [x] Inspect `scripts/check-ontos-module-contracts.mts` and repository contract validation for assumptions about schema version `0` or dependency fields; update only the checks required by the exact version `1` contract and retain all import, ownership, private-field, and deployment-isolation enforcement.

### 5. Reconcile fixtures, documentation, and planned Shell composition

- [x] Update serialized contract fixtures in `packages/core-runtime/tests/integration/action-runtime.test.ts`, `apps/shell-super-app/tests/unit/installed-module-catalog.test.ts`, `apps/shell-super-app/tests/unit/installed-outbox-matcher.test.ts`, and `apps/shell-super-app/tests/integration/module-catalog-runtime.test.ts` to omit `dependencies` and use schema version `1`.
- [x] Preserve the integration proof that two independently deployed modules can be discovered and that executable Actions/Workers remain owner-local. Remove the optional-enhancement example because no business-module relationship belongs in the manifest.
- [x] Update `docs/architecture/MODULE_MANIFESTS.md` to describe the reduced manifest and catalog invariants: Core is implicit infrastructure, setup/external readiness is not an activation gate in V0, installed business modules have independent lifecycles, and typed API/event/Outbox communication does not create lifecycle coupling.
- [x] Revise `specs/feature-module-aware-shell-composition.md` so its problem statement, solution, relevant files, tasks, tests, and acceptance criteria never evaluate dependency modes or mark a module unavailable because of another module. Composition must depend only on installation, the target module's own tenant state, permissions, and entrypoint access.
- [x] Run a final repository search for the four dependency-mode literals, removed schemas/types/errors, `manifest.dependencies`, dependency-snapshot evidence, and planned lifecycle bundles. No production source, generator, app-local guidance, active test, or planned app spec may retain them.

### 6. Run all validation commands

- [x] Execute every command under `Validation Commands` from `app/` in the listed order. Resolve failures without adding a replacement dependency abstraction, changing the database schema, weakening deployment allowlisting, or modifying `mvp/` or `mvp2/`.

## Testing Strategy

Update contract and runtime tests alongside each removed behavior. Manifest tests protect the exact version `1` shape and reject stale dependency-bearing documents. Catalog tests prove identity/runtime invariants still fail closed while independent modules and dormant subscriptions no longer require another installed module. Tenant-state unit and database integration tests prove activation depends only on the target module's installed contract and supported state, with no tenant-wide dependency read or evidence. Generator tests prove every newly scaffolded module starts with the simplified contract and emits deterministic version `1` JSON.

Shell unit and integration fixtures must continue proving bounded remote loading, exact contract decoding, immutable catalog caching, app-ID/module-ID separation, and owner-local executable registrations after the serialized shape changes. The universal module-state gate tests remain regression protection for existing per-state read/write/background behavior; this chore does not alter that matrix.

## Acceptance Criteria

- [x] Authored and serialized OntOS Module Manifests have no `dependencies` field or dependency-related public schema/type.
- [x] Deployment contracts use schema version `1`; version `0`, unknown versions, and dependency-bearing documents are rejected exactly.
- [x] The installed catalog performs no dependency graph, cycle, mandatory-dependency, or installed-producer validation while preserving identity, ownership, worker, and deployment safety checks.
- [x] An installed business module's lifecycle is unaffected by every other installed module's tenant state.
- [x] The module-state Action performs no tenant-wide dependency snapshot read, emits no dependency-inactive error, and records no dependency-snapshot access evidence.
- [x] Unknown non-inactive targets and manifest-unsupported target states still fail with declared typed errors; stale unknown state rows can still be changed to `inactive`.
- [x] No activation planner, bundle, cascade, setup gate, reverse-dependency rule, or state-transition graph is introduced.
- [x] Codesmith generates dependency-free version `1` manifests and deterministic deployment artifacts.
- [x] Typed cross-module API, event, and Outbox seams remain available but never influence installation or lifecycle decisions.
- [x] App-local architecture guidance and every planned app spec describe independent module lifecycle semantics consistently.
- [x] All focused and repository-wide validation commands pass with zero regressions.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- node --test packages/core-runtime/tests/unit/module-manifest.test.ts packages/core-runtime/tests/unit/module-catalog.test.ts packages/core-runtime/tests/unit/tenant-module-state.test.ts packages/core-runtime/tests/unit/module-state-gate.test.ts` — Validate the simplified manifest/catalog contract, state-change rules, and unchanged universal state gate.
- `mise exec -- node --test scripts/scaffolding/tests/module-contract-generator.test.mts` — Validate dependency-free Codesmith output and deterministic versioned artifacts.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — Prove every downstream business generator accepts the version `1` module marker and composes without crossing owner boundaries.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Validate Shell catalog loading, Outbox matching, and unaffected UI/runtime unit behavior.
- `mise exec -- pnpm db:test` — Run Core and Shell database/integration coverage, including transactional tenant module-state and deployment-catalog behavior.
- `mise exec -- pnpm check:module-contracts` — Validate authored/generated module owner slots, exact deployment contracts, and forbidden imports.
- `mise exec -- pnpm contract:check` — Validate the complete UltraModern workspace and topology contracts.
- `mise exec -- pnpm build` — Prove the production build accepts and preserves the simplified deployment-contract model.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This chore implements the product decision made on 2026-08-07: business modules have no activation dependencies, no optional dependency declarations, no activation-time setup, and no restricted transition graph.
- “Independent” means independent installation and tenant lifecycle. It does not prohibit communication through existing published Action/API/event/Outbox contracts; those seams remain non-authoritative for lifecycle decisions.
- There are no tracked production `verticals/*` packages on the current `develop` branch, so the breaking serialized contract can move directly from version `0` to `1` without a dual-read migration. Every generated fixture and future deployment must emit version `1` before being allowlisted.
- The current `specs/feature-module-aware-shell-composition.md` is a pre-existing untracked workspace file. Preserve unrelated user-authored content while removing only its dependency-mode assumptions during implementation.
- Repository-level `../docs/14_ONTOS_MODULE_MANIFEST.md` and related proposed documents still describe module dependency modes, but repository instructions limit this work to `app/`. App-local guidance is authoritative; repository-document reconciliation remains a separate documentation-owner follow-up.
- No Codesmith business-artifact generator must be invoked during implementation because this chore creates no Action, MicroVertical page, Outbox Message, or Policy. It updates the existing module-contract generator and its tests directly.

## Implementation Evidence

### Summary

- Removed the dependency vocabulary, graph validation, lifecycle coupling, transition snapshot read, dependency error, and dependency evidence from the versioned OntOS module contract and tenant lifecycle path.
- Bumped deployment contracts to schema version `1`; stale version `0`, future versions, and dependency-bearing authored or serialized manifests are rejected exactly.
- Preserved independent catalog identity/ownership/worker safety, the universal module-state gate, transactional state/history/audit behavior, and typed API/event/Outbox seams.

### Changed Files

- Core contract and lifecycle: `packages/core-runtime/src/index.ts`, `packages/core-runtime/src/modules/{manifest,catalog,tenant-module-state-errors,tenant-module-state-service}.ts`, and `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts`.
- Core and Shell coverage: relevant manifest, catalog, state-gate, lifecycle, Action runtime, installed-catalog, Outbox matcher, authentication runtime, and deployment-catalog tests.
- Codesmith and artifact validation: `scripts/scaffolding/module-contract/scaffold.mts`, its generator tests, and the generation/check scripts.
- Guidance and planning: `docs/architecture/MODULE_MANIFESTS.md` and `specs/feature-module-aware-shell-composition.md`.
- Tracked implementation diff: 22 files, 199 insertions, and 406 deletions. The two pre-existing untracked spec files remain untracked.

### Tests

- Focused Core manifest/catalog/lifecycle/gate tests: 24 passed.
- Module-contract generator tests: 7 passed.
- Downstream Codesmith generator composition tests: 23 passed.
- Shell unit suite: 86 passed.
- Database/integration suite on freshly migrated disposable PostgreSQL and SpiceDB services: Core 146 passed; Shell 3 passed.
- Targeted Shell catalog/Outbox tests: 10 passed; deployment-catalog integration: 1 passed.

### Validation

- `mise exec -- node --test packages/core-runtime/tests/unit/module-manifest.test.ts packages/core-runtime/tests/unit/module-catalog.test.ts packages/core-runtime/tests/unit/tenant-module-state.test.ts packages/core-runtime/tests/unit/module-state-gate.test.ts` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/module-contract-generator.test.mts` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — passed after deriving every package-marker check from the canonical contract version.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed with pre-existing ignored fixture directories temporarily isolated and restored.
- `mise exec -- pnpm db:test` — passed against freshly migrated disposable PostgreSQL and SpiceDB services.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm contract:check` — passed.
- `mise exec -- pnpm build` — passed.
- `mise exec -- pnpm check` — passed with pre-existing ignored fixture/build-output directories temporarily isolated and restored.
- Additional typechecks, formatting checks, `git diff --check`, and the final forbidden-vocabulary search passed.

### Review

- No unresolved findings remain against the applicable architecture, database, Action, Outbox, and module-contract guidance.
- Validation exposed and fixed a stale Shell authentication test catalog fixture and an inconsistent test worker entrypoint key; both now exercise the actual version `1` catalog contract.
- The final implementation introduces no replacement dependency abstraction, activation planner, lifecycle cascade, database-schema change, or public API expansion.

### Deviations

- No product or implementation deviations from the approved plan.
- The one-line Shell authentication catalog-fixture repair is intentionally retained as validation cleanup: the prescribed `db:test` exercises that path, and the stale raw `Set` did not satisfy the existing `InstalledModuleCatalog` contract. It changes no production behavior.
- The existing developer database was stale relative to tracked migrations, so the final exact database suite ran on disposable repository-migrated PostgreSQL and SpiceDB services. Pre-existing ignored `verticals/auth`, `verticals/testing`, and generated Shell output were temporarily isolated only where they interfered with repository discovery checks, then restored unchanged.
