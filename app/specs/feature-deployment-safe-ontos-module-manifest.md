---
type: feature
status: done
created: 2026-08-06
---

# Feature: Deployment-safe OntOS Module Manifest and installed-module catalog

## Feature Description

Add the missing OntOS Module Manifest contract without weakening the independently deployable
MicroVertical boundary required by `app/docs/architecture/MICROVERTICALS.md`.

Each MicroVertical will author one typed manifest as an Effect Schema-validated TypeScript value.
The manifest will describe its OntOS module identity, activation rules, dependencies, public
Actions, public Effect API, Module Federation component surface, resource types, public events,
search descriptors, and report descriptors. The owning deployment will keep executable handlers,
workers, migrations, routes, and implementation bindings in a private owner-local runtime
registration.

A build command will derive a serializable, deployment-safe contract document from the typed
manifest, generated package metadata, public API contract, Module Federation configuration, and
private registration descriptors. Each MicroVertical deployment will serve this immutable document
at a generated well-known path. The Shell will receive an explicit deployment allowlist containing
only known topology application IDs and contract URLs, fetch and Effect-decode those documents, and
assemble a Shell/Core-owned installed-module catalog without importing another deployment's private
registration or source code.

The feature must keep the two identities distinct:

- the UltraModern topology application ID identifies a deployment and remains the Module
  Federation remote and Shell gateway assertion audience, for example `property-registry`;
- the OntOS module ID identifies the business capability and remains the Action owner, tenant
  module-state key, resource owner, event producer, Policy owner, and Outbox owner, for example
  `property.registry`.

All local Codesmith generators must be updated where they currently infer business ownership from
the topology application ID or maintain a source-time cross-deployment registry.

## User Story

As an OntOS platform developer
I want each independently deployed MicroVertical to publish a validated module contract
So that Shell/Core can safely reason about installed modules, capabilities, dependencies, and
tenant activation without linking private MicroVertical implementations into the Shell

## Problem Statement

The `develop` branch has persisted tenant module state and an authenticated Shell operation for
listing active modules, but it has no OntOS Module Manifest schema, authored manifest value,
deployment contract, runtime-registration contract, or installed-module descriptor catalog.
`apps/shell-super-app/api/verticals/installed-verticals.ts` currently derives installed identifiers
directly from `topology/reference-topology.json` and treats topology application IDs as the values
stored in `core.tenant_module_states.module_key`.

That implementation cannot represent the distinction between deployment ID `property-registry`
and module ID `property.registry`, cannot validate dependencies or public surfaces, and cannot tell
Core which module capabilities are actually present. The current Action, Policy, Outbox Message,
and Outbox Worker generators repeat the same identity error by emitting the target vertical's
`modernjs.appId` as `owningModuleKey`, producer/consumer module key, and Action/worker key prefix.

The older repository-level manifest design also assumes that the Shell statically imports every
`vertical.registration.ts`. That would place routes, handlers, migrations, workers, and other
private implementation hooks in a jointly linked process. It conflicts with the authoritative
`app/` rule that every MicroVertical must remain independently deployable and that consumers cross
the seam only through generated Effect clients, published Outbox schemas, and Module Federation
exposures.

The Outbox generator has a related deployment coupling:
`scripts/scaffolding/outbox-worker/scaffold.mts` scans all vertical source trees and rewrites
`packages/core-runtime/src/outbox/subscriptions.generated.ts`. Every independently deployed worker
therefore depends on a complete source-time catalog and must be rebuilt when an unrelated vertical
adds a worker.

## Solution Statement

Implement four explicit layers with separate ownership:

1. **Deployment topology and allowlist:** generated UltraModern metadata identifies independently
   deployed application IDs, Module Federation/API locations, and an environment-specific OntOS
   contract URL. It authorizes discovery but does not define the business module identity.
2. **Typed OntOS Module Manifest:** an owner-authored TypeScript value validated by Effect Schema
   holds real Action, API, component, resource, event, search, and report values. It is the source
   contract but is never statically imported by the Shell or another MicroVertical at runtime.
3. **Deployment contract and installed-module catalog:** a build tool derives one serializable
   contract document per deployment. Shell/Core fetches only allowlisted documents, validates the
   deployment-to-module mapping and complete catalog invariants, and exposes an immutable catalog
   keyed separately by deployment ID and module ID.
4. **Private owner-local runtime registration:** executable registrations stay inside the owning
   MicroVertical deployment. Actions and workers execute only there; APIs cross through generated
   Effect clients; components cross through generated Module Federation wrappers. Deployment
   metadata may describe safe runtime identities such as worker subscriptions, but it never contains
   handlers, source paths, migrations, route trees, repositories, or arbitrary import strings.

The Shell active-module operation will intersect tenant state with catalog module IDs rather than
topology application IDs. The topology-derived application-ID inventory remains authoritative for
gateway JWT audiences. The existing tenant-state behavior remains otherwise unchanged: the current
home-page list continues to show only state `active`; expanding navigation semantics for
`read_only` or `deprecated` is outside this feature.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits implementation to `app/` and defines mandatory Codesmith generators.
- `AGENTS.md` — authoritative independent deployment, Effect, Action, Outbox, and generator rules.
- `README.md` — workspace shape, deployment metadata, strict Effect BFF topology, and supported commands.
- `docs/architecture/MICROVERTICALS.md` — non-negotiable independent deployment and communication seams.
- `docs/architecture/ACTIONS.md` — Action descriptor, owner identity, handler, event, and activation rules.
- `docs/architecture/ERRORS.md` — typed Effect failures and public HTTP mapping requirements.
- `docs/architecture/OUTBOX_WORKERS.md` — current owner-local handler and complete subscription-catalog model.
- `docs/architecture/ULTRAMODERN.md` — generated business-file and infrastructure-file rules.
- `../docs/14_ONTOS_MODULE_MANIFEST.md` — product contract surfaces and the static registration design that this feature must adapt to independent deployment.
- `../docs/05_MICROVERTICALS.md` — product terminology and module activation intent; its jointly deployed wording is non-authoritative for `app/` implementation.
- `../docs/adr/0008-module-activation-state-model.md` — tenant activation states and fail-closed entrypoint intent.
- `packages/core-runtime/src/actions/definition.ts` — current opaque Action registration and descriptor metadata available to manifest derivation.
- `packages/core-runtime/src/outbox/definition.ts` — current opaque worker registration and safe subscription descriptor shape.
- `packages/core-runtime/src/outbox/runtime.ts` — currently defaults to a source-generated global subscription catalog.
- `packages/core-runtime/src/outbox/subscriptions.generated.ts` — source-time cross-deployment catalog to retire.
- `packages/core-runtime/src/modules/tenant-module-state-service.ts` — persisted module keys and active-state read behavior.
- `packages/core-runtime/src/modules/actions/change-tenant-module-state.action.ts` — current Core module-state Action whose payload uses a module key.
- `packages/core-runtime/src/index.ts` — narrow public Core contract exports.
- `packages/core-runtime/package.json` — focused Action, Outbox, database, and typecheck commands.
- `apps/shell-super-app/api/verticals/installed-verticals.ts` — topology app-ID decoder currently misused as the installed-module inventory.
- `apps/shell-super-app/api/auth/gateway-issuer.ts` — must continue authorizing gateway audiences by topology application ID.
- `apps/shell-super-app/api/index.ts` — current authenticated active-module handler and Shell runtime-layer composition.
- `apps/shell-super-app/shared/api.ts` — current active-module transport contract.
- `apps/shell-super-app/modern.config.ts` — current build-time topology injection point.
- `apps/shell-super-app/rstest.config.ts` — unit-test topology injection matching production configuration.
- `apps/shell-super-app/tests/unit/installed-verticals.test.ts` — topology application-ID regression tests.
- `apps/shell-super-app/tests/unit/active-modules-runtime.test.ts` — installed/active intersection and typed failure tests.
- `topology/reference-topology.json` — generated delivery-unit inventory, not an OntOS module registry.
- `topology/local-overlays/development.json` — environment-specific deployment URLs and the place to carry generated contract locations.
- `scripts/generate-public-surface-assets.mts` — established post-build artifact-generation pattern.
- `scripts/validate-ultramodern-workspace.mts` — topology, overlay, package, build, and generated-contract validation.
- `scripts/check-ultramodern-api-boundaries.mts` — existing server/client and vertical-boundary validation.
- `scripts/outbox-worker-subscription-catalog.mts` — current source-time subscription catalog renderer to replace or narrow.
- `scripts/published-outbox-contracts.mts` — schema-only cross-vertical Outbox contract enforcement to preserve.
- `scripts/scaffolding/cli.mts` — command definitions, help, result types, and Codesmith execution.
- `scripts/scaffolding/shared.mts` — current delivery-unit discovery and generator mutation primitives.
- `scripts/scaffolding/action/scaffold.mts` — currently emits `appId` as the Action owner and key prefix.
- `scripts/scaffolding/policy/scaffold.mts` — currently emits `appId` as a MicroVertical Policy owner and key prefix.
- `scripts/scaffolding/outbox-message/scaffold.mts` — currently emits `appId` as the producer module key.
- `scripts/scaffolding/outbox-worker/scaffold.mts` — currently emits `appId` ownership and mutates the shared source-time subscription catalog.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — must keep the deployment ID for Module Federation while adding module identity for activation metadata.
- `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` — must keep the deployment ID as the assertion audience while validating the deployment/module pairing.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable two-vertical fixtures, mutation safety, composition, formatting, and generated-output compilation.
- `scripts/scaffolding/tsconfig.json` — strict generator and generated-fixture typechecking.
- `package.json` — new scaffold/artifact/boundary commands and final quality-gate wiring.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` — preserve the pinned Effect/UltraModern cohort and record only unavoidable direct dependency changes.

### New Files

- `docs/architecture/MODULE_MANIFESTS.md` — authoritative app-local deployment-safe manifest, catalog, identity, and runtime-registration rules.
- `packages/core-runtime/src/modules/manifest.ts` — Effect Schemas, literal-preserving authoring helper, and serializable deployment-contract types.
- `packages/core-runtime/src/modules/runtime-registration.ts` — private owner-local registration helper and safe descriptor extraction.
- `packages/core-runtime/src/modules/catalog.ts` — pure aggregate validation and immutable dual-key installed-module catalog.
- `packages/core-runtime/tests/unit/module-manifest.test.ts` — manifest and deployment-contract schema/invariant tests.
- `packages/core-runtime/tests/unit/module-catalog.test.ts` — aggregate identity, dependency, duplication, and lookup tests.
- `scripts/generate-ontos-module-contract.mts` — build-time derivation and deterministic JSON emission for one vertical deployment.
- `scripts/scaffolding/module-contract/scaffold.mts` — Codesmith generator for the initial `vertical.manifest.ts` and private `vertical.registration.ts` owner files and build wiring.
- `apps/shell-super-app/api/modules/deployment-allowlist.ts` — typed decoder for allowlisted topology app IDs and contract URLs.
- `apps/shell-super-app/api/modules/installed-module-catalog.ts` — bounded Effect HTTP loading, validation, and lazy caching for the Shell catalog.
- `apps/shell-super-app/tests/unit/deployment-allowlist.test.ts` — malformed, duplicate, unsafe URL, and topology mismatch tests.
- `apps/shell-super-app/tests/unit/installed-module-catalog.test.ts` — remote contract loading, dual identity, failure, and caching tests.
- `verticals/<vertical>/vertical.manifest.ts` — generated typed manifest owner file in future/fixture verticals; no production vertical is added by this feature.
- `verticals/<vertical>/vertical.registration.ts` — generated private local runtime-registration owner file in future/fixture verticals; no production vertical is added by this feature.

## Implementation Plan

### Phase 1: Foundation

Define the app-authoritative terminology and Effect Schema contracts. Separate topology deployment
identity from OntOS business identity, define the authored manifest and generated deployment
document, and establish a private registration that can expose descriptors to owner-local runtime
composition without exposing executable values to Shell/Core.

Add and test the module-contract Codesmith generator before any manifest or registration owner file
is created. Because `verticals/*` is empty on `develop`, prove generated output in disposable
UltraModern-shaped fixtures rather than adding a demonstration business MicroVertical.

### Phase 2: Core Implementation

Implement deterministic contract emission and an immutable installed-module catalog. Update every
affected generator to consume the manifest's OntOS module ID, patch only explicit generated owner
slots, preserve topology application IDs at deployment/MF/authentication seams, and replace the
source-time Outbox subscription catalog with descriptor metadata derived from deployed contracts.

### Phase 3: Integration

Add Shell allowlist loading and fail-closed remote contract validation, then replace only the active
module list's topology-ID intersection with module-ID catalog lookup. Preserve gateway audience
behavior and private runtime execution. Extend repository validators, generated-fixture integration
tests, documentation, and production build checks so no static import of another vertical's manifest
or registration can reappear.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Codify the deployment-safe contract and identity model

- [x] Add `docs/architecture/MODULE_MANIFESTS.md` and update `AGENTS.md`, `README.md`, `docs/architecture/MICROVERTICALS.md`, `docs/architecture/ACTIONS.md`, `docs/architecture/OUTBOX_WORKERS.md`, and `docs/architecture/ULTRAMODERN.md` to define the four layers, distinguish `appId` from `moduleId`, forbid Shell/consumer imports of `vertical.manifest.ts` and `vertical.registration.ts`, and keep executable registrations owner-local.
- [x] Explicitly document that the deployment allowlist authorizes known contract URLs; a reachable service cannot install itself, manifests are data rather than executable plugins, and tenant activation remains separate from deployment installation.
- [x] Define the generated contract endpoint as `/.well-known/ontos-module-manifest.json`. Require HTTPS outside loopback development, exact topology app-ID matching, no redirects, `application/json`, a 1 MiB response limit, a five-second request deadline, and a versioned schema.
- [x] In `packages/core-runtime/src/modules/manifest.ts`, add Effect Schemas and types for stable dotted module IDs, module kinds, activation states/rules, the four documented dependency modes, known Core dependencies, external-system dependencies, Action metadata, API metadata, Module Federation component metadata, resource descriptors, public event descriptors with payload contracts, search descriptors, report descriptors, deployment identity, and safe runtime descriptors such as Outbox subscriptions.
- [x] Implement `defineOntosModuleManifest` so the authored value is decoded/validated at creation, preserves literal types, freezes its public shape, accepts real typed Action/API/component/schema values, and rejects private fields, authored source/import/export paths, duplicate keys, cross-owner Actions/events/resources, and references to undeclared resources.
- [x] Implement `defineVerticalRuntimeRegistration` in `runtime-registration.ts` as an opaque owner-local value. It must require the same manifest identity, keep handlers and other executable hooks inaccessible through the public manifest/serialized contract, and expose only safe descriptor extraction to the build tool and owning runtime.
- [x] Implement pure catalog aggregation in `catalog.ts` with lookups by deployment app ID and OntOS module ID. Reject duplicate IDs, one deployment claiming multiple modules in V0, one module claimed by multiple deployments, missing required module dependencies, self-dependencies, dependency cycles in `must_be_active_first`, deployment/manifest identity mismatch, and unknown schema versions.
- [x] Add unit tests beside the schemas for valid empty and populated manifests, literal inference, exact decoding, immutability, every invalid identity/reference/private-field case, duplicate/cyclic catalogs, and the valid mapping `property-registry` to `property.registry`.
- [x] Keep the V0 implementation limited to one `business_module` per MicroVertical deployment. Model known `core.*` dependencies as a closed Core capability vocabulary; do not invent independently activatable Core system-module manifests in this feature.

### 2. Add the module-contract Codesmith generator and deterministic build artifact

- [x] Add `scaffold:module-contract` to `package.json` and `scripts/scaffolding/cli.mts` with exact write-free help for `mise exec -- pnpm scaffold:module-contract -- --vertical <vertical> --module <dotted.module-id>`. Add its config/result types and owner-slot constants to `scripts/scaffolding/shared.mts` and document it as mandatory before other business generators target a new MicroVertical.
- [x] Implement `scripts/scaffolding/module-contract/scaffold.mts` using the existing Codesmith planning/mutation primitives. It must discover one generated topology-backed delivery unit without requiring an existing manifest, reject invalid or duplicate module IDs, and create the initial `vertical.manifest.ts` and `vertical.registration.ts` with explicit generated import/entry slots.
- [x] Generate a conservative business-module manifest starter: derived display name, tenant activation scope, default `inactive`, the existing seven-state vocabulary, history preservation, required Core capability dependencies, and empty public Actions/API/components/resources/events/search/reports. Do not generate placeholder business behavior.
- [x] Patch the target package only after full preflight: add the exact Core contract dependency, record a generated manifest entrypoint marker without publishing the private registration as a package export, and extend existing build/cloudflare-build scripts to run the artifact generator after the owning app build and before deploy output packaging.
- [x] Implement `scripts/generate-ontos-module-contract.mts` to bundle a temporary server-only entry for only the owning vertical's manifest and private registration with the repository-managed build tool, load that bundle in a Node build context, validate its identity, derive API metadata from the Effect API value, component metadata from Module Federation exposures, Action/event schema metadata from runtime descriptors, package/build metadata from generated workspace files, and safe worker subscription metadata from the private registration. This build path must support referenced `.ts` and `.tsx` values without publishing the temporary bundle.
- [x] Emit deterministic JSON to the correct Modern and Cloudflare public output without modifying source-controlled public assets. Never serialize functions, Effect programs, React components, handlers, migrations, routes, repositories, source paths, raw import specifiers, fixtures, tests, secrets, or private runtime values.
- [x] Extend the target's generated build/proof contract and `scripts/validate-ultramodern-workspace.mts` so normal and Cloudflare outputs contain the well-known document with `application/json`, `Cache-Control: no-cache`, a strong build-marker ETag, the size bound, module/deployment identity, and build marker. A build must fail before deployment if derivation or validation fails.
- [x] Add disposable generator/artifact tests before using the new command anywhere. Cover help, missing/unknown flags, traversal, malformed/duplicate module IDs, non-vertical targets, overwrite refusal, missing owner slots, partial-write prevention, preserved developer content/package ordering, formatting, deterministic output, target-specific paths, and strict compilation.
- [x] Do not add a production vertical to `develop`. Use two disposable fixture deployments with distinct app/module IDs to prove contract generation.

### 3. Update every affected Codesmith generator to respect both identities

- [x] Refactor `scripts/scaffolding/shared.mts` into delivery-unit discovery and manifest-backed OntOS module discovery. All business generators must require a valid generated manifest, read its generator-owned module-ID marker, and fail when the marker, manifest value, package, or topology entry disagree.
- [x] Update `scaffold:action` for MicroVertical ownership to use `moduleId` for `owningModuleKey`, Action key, access policy key, event ownership markers, and generated tests. Patch the real Action value into both the manifest's public Action slot and the private registration's Action slot atomically. Leave the Core-owned Action form unchanged.
- [x] Update `scaffold:policy` so MicroVertical Policies use `moduleId` for their owner and key. Keep global Policies unchanged and do not publish executable Policies in the manifest.
- [x] Update `scaffold:outbox-message` so producer module keys and generated ownership markers use `moduleId` while preserving exact schema-only package exports. Do not treat every Outbox Message as a public module event; only explicitly declared public Domain Events belong in the manifest.
- [x] Update `scaffold:outbox-worker` so consumer/producer/worker identities use manifest module IDs, the private owner registration receives the worker value, and the generated deployment contract receives only its schema-free subscription descriptor. Stop scanning unrelated vertical source and stop rewriting `packages/core-runtime/src/outbox/subscriptions.generated.ts`.
- [x] Split the current combined Outbox cycle at its existing Core/owner boundary: a Core-owned matcher consumes the complete validated subscription snapshot derived from installed deployment contracts and creates deliveries, while each MicroVertical worker process only claims and executes deliveries for its owner-local registrations. Remove the Core runtime's default import of `subscriptions.generated.ts`; fail matching when catalog descriptors are invalid and fail worker startup when a local registration contradicts its deployed descriptor.
- [x] Update `scaffold:microvertical-page` to keep `appId` in `ownerAppId`, `mfBoundaryId`, route generation, and Module Federation metadata, while adding the manifest `moduleId` to generated route metadata used by module-state gates. Routes remain private and are not added to the public manifest.
- [x] Update `scaffold:microvertical-action-boundary` to require a valid module/deployment pairing but continue embedding the topology `appId` as `ACTION_GATEWAY_AUDIENCE`; never substitute the dotted module ID into JWT audience verification.
- [x] Update CLI help, `AGENTS.md`, generator result types, strict tooling typecheck, and the complete disposable composition matrix. Prove every command is order-independent after `module-contract`, all generated owners use the module ID, all deployment/MF/authentication values use the app ID, reruns fail without partial writes, and no generator mutates Shell source or another vertical's private registration.
- [x] Retire `scripts/outbox-worker-subscription-catalog.mts` and `packages/core-runtime/src/outbox/subscriptions.generated.ts` only after their runtime and validator consumers use the deployment catalog. Preserve `scripts/published-outbox-contracts.mts` and its cross-vertical schema-only import checks.

### 4. Build the Shell deployment allowlist and installed-module catalog

- [x] Add a generated `ontosModuleManifests` map to `topology/local-overlays/development.json`, keyed by exact topology app ID and containing the local well-known contract URL. Extend topology/overlay validation so entries exactly match the vertical cohort with no Shell/package/unknown/missing keys. Keep this map distinct from existing Module Federation `manifests` and BFF `apis` maps.
- [x] Add `deployment-allowlist.ts` to decode the injected reference topology plus environment overlay/config into immutable `{ appId, contractUrl }` entries. Reject credentials in URLs, fragments, unsafe schemes, duplicate normalized URLs, non-loopback HTTP outside development, and any mismatch with topology verticals.
- [x] Add `installed-module-catalog.ts` as a lazy Effect service used only by module/catalog operations. Fetch each allowlisted URL with the exact deadline/size limits, no redirect following, exact JSON/content-type handling, Effect Schema decoding, and aggregate catalog validation. Cache only a completely valid immutable snapshot for the injected deployment-allowlist revision; never cache a partial or failed catalog. A deployment revision change must recreate the Layer and atomically replace the whole snapshot rather than mutating it entry by entry.
- [x] Keep ordinary Shell authentication, session, sign-out, and gateway configuration independent from remote module-contract availability. Catalog unavailability must fail only module-dependent operations with typed sanitized errors; malformed allowlisted configuration or contradictory build metadata must fail closed and remain observable without exposing URLs or response bodies to clients.
- [x] Add unit/integration fixtures using two local HTTP contract servers. Prove successful dual-key lookup, deterministic ordering, one fetch per cached snapshot, unavailable/timeout/oversized/redirect/non-JSON/invalid-schema/mismatched-app/duplicate-module failures, no arbitrary URL fetch, and no execution/import of returned content.
- [x] Extend `scripts/validate-ultramodern-workspace.mts`, `scripts/check-ultramodern-api-boundaries.mts`, package exports, and import scanning to forbid Shell/Core or ordinary MicroVertical source imports of another vertical's manifest/registration/private paths. Permit only generated Effect clients, Module Federation exposures, and published schema-only Outbox contracts across the seam.
- [x] Add a stable `mise exec -- pnpm check:module-contracts` command for authored manifests, generated owner slots, topology/overlay mapping, emitted contract schemas, dependency graph, public-surface/MF/API consistency, and forbidden-import validation; wire it into `mise exec -- pnpm check`.

### 5. Integrate catalog module IDs with tenant state and private runtime execution

- [x] Keep `deriveInstalledVerticalIds` as the topology application-ID decoder used by gateway assertion audience validation. Rename it only if necessary for clarity, and add regression tests proving `property-registry` remains the accepted audience while `property.registry` is not an audience.
- [x] Replace the active-module handler's installed-ID intersection in `apps/shell-super-app/api/index.ts` with the installed catalog's module-ID set. Persisted `{ moduleKey: 'property.registry', state: 'active' }` must be returned when the allowlisted deployment `property-registry` publishes that module; a persisted deployment ID or unknown/stale module ID must be filtered out.
- [x] Preserve the existing `GET /modules/active` success and Problem Details schema unless catalog loading needs an additional internal typed cause. Map remote catalog unavailability to the existing sanitized retryable `503` and invariant/configuration defects to the existing sanitized `500`; do not expose deployment URLs or manifest bodies.
- [x] Add an installed-catalog membership check to Core module-state transitions before a module can enter a non-`inactive` state. Unknown modules, unsupported states for the target manifest, and absent mandatory dependencies must fail with declared typed errors before module-state persistence. Keep trusted tenant/principal context outside the payload and do not turn reads into Actions.
- [x] If the current Action handler type cannot receive the catalog without erasing Effect requirements, extend the opaque Action registration/runtime generics and owner-local Layer composition rather than using globals, hidden fetches, payload metadata, or direct Shell imports. Update the Action Codesmith template and Action runtime tests with the new requirement-safe shape.
- [x] Keep private runtime registrations inside their owning deployments. Prove owner-local Action/worker lookup succeeds without the Shell importing handlers, another vertical cannot access executable hooks, and serialized contracts contain only safe descriptors.
- [x] Add Core and Shell tests for app-ID/module-ID separation, active/stale filtering, unknown-module transition rejection, dependency activation ordering, no state/history writes on rejection, catalog-unavailable typed failures, and unchanged authenticated dashboard behavior.
- [x] Add an integration proof with two disposable independently served vertical contracts, one active tenant module, one inactive module, one owner-local Action, one owner-local worker, a generated Effect API client reference, and a Module Federation component descriptor. Prove the Shell discovers metadata over HTTP while executable code remains in the owner process.

### 6. Reconcile validators, run all gates, and review deployment isolation

- [x] Update all app-local guidance and generator documentation after implementation. Record that repository-level `../docs/03_ARCHITECTURE_OVERVIEW.md`, `../docs/04_C4_MODEL.md`, `../docs/05_MICROVERTICALS.md`, `../docs/14_ONTOS_MODULE_MANIFEST.md`, `../docs/CONTEXT.md`, and proposed ADRs still describe a jointly deployed/static registry and require a separate documentation-owner reconciliation outside this `app/`-only change.
- [x] Inspect the final diff for static vertical registration imports, cross-vertical source dependencies, app IDs used as module IDs, module IDs used as MF names/JWT audiences, executable values in JSON, private paths, unbounded remote fetches, stale source subscription catalogs, generated build artifacts, sample business verticals, and unrelated framework rewrites.
- [x] From `app/`, execute every command under `Validation Commands` in order and resolve every failure without changing files under `mvp/` or `mvp2/`, weakening the independent deployment seam, or adding a production MicroVertical.

## Testing Strategy

### Unit Tests

Use Effect Schema tests for every authored and serialized manifest surface, stable IDs, activation
rules, dependency modes, cross-references, deployment identity, duplicate rejection, catalog graph
validation, immutability, and private-field exclusion. Test the private registration's handler
opacity and safe descriptor extraction. Extend Action and Outbox tests for catalog-supplied runtime
requirements and removal of the source-generated subscription default.

Use disposable Codesmith fixtures for the new module-contract command and all existing commands.
Assert exact owner slots, no-partial-write preflight, preservation of developer code and JSON order,
correct module/deployment identity use, deterministic output, formatter stability, and compilation
against the real Core contracts.

### Integration Tests

Run local fixture HTTP servers that act as two separately deployed MicroVerticals. Configure the
Shell with an explicit allowlist, serve valid and invalid well-known contracts, and prove that the
Shell builds its catalog without importing fixture source. Combine the catalog with real Core
tenant-state services to prove module-ID filtering and transition rejection.

Exercise a generated owner-local Action and worker registration separately from the Shell process.
Verify that only metadata crosses the deployment boundary, that the Core matcher uses the complete
subscription snapshot, that workers claim only already-created owner-local deliveries, and that
handler execution remains local.

### Edge Cases

- A topology app ID and OntOS module ID are equal by coincidence; validation must still treat them as different identity roles.
- One allowlisted deployment claims a different app ID, more than one module, or an already claimed module ID.
- A contract is unavailable, slow, oversized, redirected, stale, malformed, the wrong content type, or an unsupported schema version.
- A manifest contains functions or private implementation metadata in a serializable field.
- An Action, Policy, event, resource, worker, or Outbox producer claims an owner different from the manifest module ID.
- A component is listed without a generated Module Federation exposure, or an exposure is claimed by multiple public components.
- An API value is listed without a derivable Effect API contract.
- Required dependencies are missing, self-referential, cyclic, inactive, or supplied only as optional enhancements.
- Tenant state contains a stale topology app ID, a non-installed module ID, or a module state unsupported by the installed manifest.
- An unrelated module contract is unavailable while Shell login/session/logout or gateway issuance is used.
- The Core matcher receives an incomplete or contradictory installed subscription snapshot, or a worker's owner-local registration differs from its deployed descriptor.
- Generator commands run before `scaffold:module-contract`, after developer edits to owner slots, twice, or against mismatched topology/package metadata.

## Acceptance Criteria

- [x] Every generated business MicroVertical can own one Effect Schema-validated OntOS Module Manifest covering identity, activation, dependencies, Actions, API, components, resources, events, search, and reports.
- [x] Each deployment emits and serves one deterministic versioned `/.well-known/ontos-module-manifest.json` containing no executable or private implementation value.
- [x] Shell/Core discovers only explicitly allowlisted deployment URLs and never statically imports another MicroVertical's manifest or private registration.
- [x] The installed catalog preserves distinct app-ID and module-ID indexes and rejects all ambiguous mappings.
- [x] Private Actions, handlers, workers, migrations, routes, search/report implementations, and repositories remain inside their owning deployment.
- [x] Generated Effect clients, Module Federation exposures, and schema-only Outbox contracts remain the only supported cross-MicroVertical communication surfaces.
- [x] Gateway assertions continue to use topology application IDs as audiences.
- [x] Tenant module state and all generated business ownership keys use OntOS module IDs.
- [x] The active-module Shell operation maps `property-registry` deployment metadata to persisted `property.registry` state and filters stale/unknown keys.
- [x] Action, Policy, Outbox Message, Outbox Worker, page, and Action identity-boundary generators use the correct identity for every emitted field and fail when the module contract is absent or inconsistent.
- [x] `scaffold:outbox-worker` no longer rewrites a source-time catalog in shared Core; the Core-owned matcher consumes the complete deployment-catalog subscription snapshot, while independently deployed workers claim and execute only owner-local deliveries and handlers.
- [x] Unknown module activation and unsatisfied mandatory dependencies fail before tenant module-state persistence with declared typed Effect errors.
- [x] Catalog failure does not break unrelated Shell authentication/session/logout or gateway operations.
- [x] Repository validation forbids static/private cross-vertical imports and verifies authored, emitted, and deployed contract consistency.
- [x] No production/sample vertical, generated build output, or file under `mvp/` or `mvp2/` is added or modified.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — Strictly typecheck Codesmith and contract-generation tooling.
- `mise exec -- pnpm exec oxlint scripts/scaffolding scripts/generate-ontos-module-contract.mts` — Lint generator and artifact tooling directly.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — Run disposable generator, composition, artifact, and deployment-boundary fixtures.
- `mise exec -- pnpm scaffold:module-contract -- --help` — Prove the new mandatory generator documents its write-free contract.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Validate Action descriptor/runtime changes and module-state rejection behavior.
- `mise exec -- pnpm outbox:test` — Validate catalog-supplied Outbox matching, owner-local execution, and worker processes.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Validate tenant module-state persistence and no-write rejection integration.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Validate deployment allowlist, installed catalog, active-module behavior, and gateway regressions.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — Validate authenticated Shell/Core/catalog behavior with real runtime composition.
- `mise exec -- pnpm check:module-contracts` — Validate authored manifests, private registrations, generated metadata, dependency graph, and import boundaries.
- `mise exec -- pnpm api:check` — Validate strict Effect BFF and server/browser API boundaries.
- `mise exec -- pnpm contract:check` — Validate UltraModern topology, overlay, package, generator, and deployment contracts.
- `mise exec -- pnpm typecheck` — Typecheck the complete project-reference graph.
- `mise exec -- pnpm build` — Prove production Shell, generated contract assets, Module Federation types, and performance readiness.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Summary

- Implemented the typed manifest, opaque owner-local runtime registration, deterministic deployment
  contract generation, immutable dual-key catalog, environment-specific Shell allowlist, bounded
  catalog loading, catalog-backed active-module filtering, and deployment-catalog Outbox matching.
- Corrected the final review findings: real branded Action/API/component/Schema values are required;
  Effect API operation keys are derived; Cloudflare output maps to `dist-cloudflare`; import checks
  permit only same-owner registration access; activation dependency reads share the Action
  transaction and record Data Access evidence; and the combined two-deployment proof now covers one
  active and one inactive module plus owner-local Action/worker execution boundaries.
- Added the generated workspace skills lock and its required third-party license so repository
  contract validation is reproducible in this worktree. Provisioned isolated local PostgreSQL and
  SpiceDB validation resources, then fixed a database-test fixture that could generate an invalid
  dotted module ID when a UUID segment began with a digit.

### Changed Files

- 67 tracked or newly added files across Core runtime contracts, Shell discovery/runtime wiring,
  Codesmith generators and validators, architecture guidance, topology configuration, workspace
  skill metadata, and tests.
- The final count includes newly added files that plain `git diff --stat` omits until tracked.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/module-manifest.test.ts` — real typed public values, exact schema
  decoding, ownership/reference rejection, immutability, and safe serialization.
- `packages/core-runtime/tests/unit/module-catalog.test.ts` — dual identities, dependency graphs, and
  complete deterministic Outbox subscription snapshots.
- `packages/core-runtime/tests/unit/tenant-module-state.test.ts` and
  `packages/core-runtime/tests/integration/tenant-module-state.test.ts` — installed membership,
  supported-state and active-first checks, transaction serialization, no-write rejection, and
  truthful dependency-read evidence; integration fixture module IDs are valid for every UUID.
- `apps/shell-super-app/tests/unit/deployment-allowlist.test.ts`,
  `installed-module-catalog.test.ts`, and `installed-outbox-matcher.test.ts` — safe environment URL
  derivation, bounded atomic loading/cache revision behavior, and catalog-to-matcher provenance.
- `apps/shell-super-app/tests/integration/module-catalog-runtime.test.ts` — two separately served
  contracts, active/inactive tenant state, owner-local Action and worker references, Effect API
  client reference, Module Federation descriptor, and metadata-only HTTP discovery.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` and
  `scaffold-generators.test.mts` — generator composition, actual Cloudflare output root, derived API
  operations, authored/emitted contract validation, and ownership-aware private import enforcement.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- pnpm exec oxlint scripts/scaffolding scripts/generate-ontos-module-contract.mts` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — passed, 30 tests.
- `mise exec -- pnpm scaffold:module-contract -- --help` — passed and wrote no files.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed, 48 tests.
- `mise exec -- pnpm outbox:test` — passed, 19 unit and 8 database integration tests.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — passed, 127 tests against isolated local
  PostgreSQL and SpiceDB validation resources.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 71 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — passed, 2 integration tests,
  including authenticated Shell/Core behavior and the combined deployment-isolation proof.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm contract:check` — passed after installing and validating the pinned workspace
  skills from `.agents/skills-lock.json`.
- `mise exec -- pnpm typecheck` — passed; direct strict Core and Shell package typechecks also passed.
- `mise exec -- pnpm build` — passed, including MF type and performance-readiness checks.
- `mise exec -- pnpm check` — passed as the final repository quality gate.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, all seven relevant app-local architecture guides, and the
  referenced repository-level module, MicroVertical, and activation documents. App-local guidance
  remains authoritative where the older product documents describe a static joint registry.
- Reviewed `git status --short`, `git diff --check`, the diff/stat, runtime and generator changes,
  identity usage, build roots, private imports, serialized fields, remote-fetch limits, and deleted
  source-time Outbox catalog. The final review additionally closed a loophole that could have let an
  owner registration import another deployment's owner file.
- No UI component or visual behavior was introduced, so screenshot/browser review was not applicable;
  authenticated runtime behavior was covered by the passing Shell integration suite.

### Deviations and Follow-ups

- No implementation or validation blocker remains. Disposable local database/auth configuration and
  an isolated SpiceDB instance were used only for the final integration gates; no secret file was
  read or modified.
- Repository-level documentation still describing a jointly deployed/static registry remains the
  already documented out-of-scope documentation-owner follow-up.

## Notes

- The plan is based only on the current `develop` commit `cc4fefea4940a1dab097148a93ce65199fddd957` in a detached worktree. The original `develop` worktree was not modified.
- `app/docs/architecture/*` is authoritative for implementation and requires independently deployable MicroVerticals. Several repository-level documents still describe a jointly deployed modular monolith and static private registry. This spec records that discrepancy but does not plan edits outside `app/`, as required by repository instructions.
- The runtime remains an explicit installed deployment set, not a plugin marketplace. Adding a new deployment still requires controlled topology/allowlist configuration; tenant activation does not install code.
- V0 supports one OntOS Business Module per MicroVertical deployment. Multi-module deployments and separately activatable Core system-module manifests are deferred.
- Public deep-link builders and per-surface stability levels remain deferred, matching the open questions in `../docs/14_ONTOS_MODULE_MANIFEST.md`.
- The repository currently contains no production `verticals/*` package. Disposable fixtures must prove the complete design until the first real business MicroVertical is generated.
- A new Codesmith generator is required because `vertical.manifest.ts` and `vertical.registration.ts` are new business owner files. The generator must exist and be tested before either file is created in a real vertical; hand-creation remains forbidden.
- No unresolved developer decision blocks implementation.
- Final validation completed on 2026-08-07. Every command under `Validation Commands` passed in the
  detached worktree, including database/auth integration, workspace contract, production build, and
  final repository quality gates.
