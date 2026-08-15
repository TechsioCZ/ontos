---
type: chore
status: done
created: 2026-08-14
---

# Chore: Support dynamic MicroVertical pages

## Chore Description

Extend the mandatory `scaffold:microvertical-page` Codesmith generator and the authenticated Shell
page gateway so an owner can generate a private exact page whose canonical URL contains safe named
parameters, such as `/crm/customers/:id/edit`. Today the generator accepts only static lowercase
kebab-case segments and explicitly rejects parameters, even though the UltraModern route metadata
and existing Shell-owned resource routes already use `:parameter` patterns backed by `[parameter]`
filesystem segments.

The extension must keep dynamic page URLs declarative and non-executable in the serialized module
contract, omit them from ordinary module navigation because a route template is not a usable href,
preserve exact Shell/Core page gating before a remote loads, and pass only a bounded route-parameter
map to the approved remote component. Route parameters remain untrusted business input; they never
become tenant, principal, legal-entity, authorization, or module-state context.

## Relevant Files

Use these files to accomplish the chore:

- `../AGENTS.md` — mandatory page-generator rule and `app/`-only scope.
- `AGENTS.md` — authoritative module-entrypoint, generator, MicroVertical, and toolchain constraints.
- `README.md` — public documentation for `scaffold:microvertical-page` URL behavior.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — exact-page resolution, lazy remote loading, and fail-closed Shell gateway ordering.
- `docs/architecture/MODULE_MANIFESTS.md` — safe serialized `routePath` contract and generator order.
- `docs/architecture/MICROVERTICALS.md` — independent deployment and private implementation boundaries.
- `scripts/scaffolding/cli.mts` — page command help and argument surface.
- `scripts/scaffolding/shared.mts` — page scaffold configuration/result types and shared mutation safety.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — authoritative URL parser, filesystem rendering, manifest/registration wiring, Shell connector generation, collision checks, rerun detection, and atomic mutation plan.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-workspace coverage for exact output, unsafe input, collisions, composition, reruns, and no-partial-write behavior.
- `packages/core-runtime/src/modules/shell-contribution.ts` — Effect Schema for serialized Shell page `routePath` values.
- `packages/core-runtime/tests/unit/shell-contribution.test.ts` — safe route-template contract tests.
- `apps/shell-super-app/src/api/vertical-clients.ts` — approved remote page component contract and generated lazy client allowlist.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic exact-target loader model that must retain bounded route parameters separately from the resolved target.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell composition that passes route parameters only after exact target resolution and lazy remote loading.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — serializable route-parameter loader coverage.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — remote-load ordering and approved component-prop coverage.
- `apps/shell-super-app/src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/route.meta.ts` — existing safe canonical/localized dynamic-route convention.
- `verticals/crm/src/routes/ultramodern-route-head.tsx` — existing `:parameter` route-metadata matching behavior that generated output must continue to satisfy.
- `specs/chore-extend-microvertical-page-generator.md` — completed static/nested URL work whose compatibility, collision, and atomicity guarantees must be preserved.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the safe dynamic route contract

- [x] Update `packages/core-runtime/src/modules/shell-contribution.ts` so a page `routePath` accepts static lowercase kebab segments and safe named `:parameter` segments, while retaining the 200-character bound and rejecting locale prefixes, empty/dot segments, trailing slashes, queries, fragments, origins, encoded traversal, wildcards, optional/catch-all syntax, invalid parameter names, and repeated parameter names.
- [x] Extend `packages/core-runtime/tests/unit/shell-contribution.test.ts` with accepted mixed templates such as `/crm/customers/:id/edit` and rejected unsafe/ambiguous templates; keep the serialized contract plain data with no functions, loaders, imports, or private implementation metadata.

### 2. Extend Codesmith URL parsing and filesystem mapping

- [x] Refactor the page route model in `scripts/scaffolding/microvertical-page/scaffold.mts` to retain the canonical template segments separately from router filesystem segments, mapping `:id` deterministically to `[id]` while continuing to use the canonical `:id` spelling in manifest `routePath`, route metadata, localized-path metadata, route ownership, and collision identities.
- [x] Accept named parameters only through explicit `--url`; keep the omitted-URL compatibility path `/<vertical>/<page>` static. Update `scripts/scaffolding/cli.mts` help and `README.md` to document the grammar and show `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page customer-edit --url /crm/customers/:id/edit`.
- [x] Preserve containment and atomic preflight. Treat two templates that differ only in parameter name at the same segment as a routing collision, detect static-versus-dynamic sibling collisions, reject reserved Shell prefixes, and make a successful exact rerun a no-op without weakening developer-edited-output checks.

### 3. Generate non-navigational dynamic page contributions

- [x] Keep a dynamic page in the manifest `pages`, public component, private page registration, Module Federation exposure, and exact Shell lazy-client slots, but do not emit a `navigation` contribution for it because `/crm/customers/:id/edit` is a route template rather than a valid destination. Preserve ordinary navigation generation for static pages.
- [x] Update owned-route discovery, generated-wiring comparison, collision detection, locale patching, route metadata rendering, relative imports, formatter stability, and current/legacy rerun handling to use the correct canonical versus filesystem segment representation at arbitrary supported nesting depth.

### 4. Carry route parameters through the authenticated Shell page gateway

- [x] Extend the generated dynamic Shell connector loader to receive the router's exact declared parameters, select only the generated parameter names, and pass a bounded readonly string record into the generic module-target loader. Static connectors continue to supply an empty record.
- [x] Extend `ModuleTargetPageModel` and `ApprovedVerticalPageComponent` so the Shell keeps `routeParams` separate from `ResolvedModuleTarget`, and passes them to the remote component only after authentication, legal-entity selection, exact page resolution, module-state/permission success, approved-client lookup, and successful lazy load. Do not add route parameters to the module contract, target-resolution BFF input, trusted principal context, or authorization decisions.
- [x] Update the generated federated wrapper and owner page starter contract so a dynamic page receives its declared route parameters as plain props without importing Shell implementation types or changing static page behavior.

### 5. Add generator and Shell regression coverage

- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` to generate `customer-edit` at `/crm/customers/:id/edit` and prove `[lang]/crm/customers/[id]/edit` owner/Shell directories, canonical `:id` metadata, no navigation entry, exact page/registration/federation/client wiring, typed props, English/Czech locale entries, compilation, deterministic formatting, and an idempotent rerun.
- [x] Add table-driven no-write failures for invalid/repeated parameters, wildcard/catch-all/optional syntax, encoded traversal, locale-prefixed URLs, collisions between `[id]` and another dynamic name, static/dynamic sibling conflicts, another owner claiming the same template, modified generated output, and partial pre-existing output.
- [x] Update Shell loader/page unit tests to prove only declared route parameters reach the approved remote, static pages receive an empty record, denied/unavailable/not-found targets never consult or load the private registry, and parameter input cannot alter the resolved app/module/component/entrypoint identity.

### 6. Update authoritative guidance

- [x] Update `docs/architecture/MODULE_MANIFESTS.md` and `docs/architecture/MODULE_ENTRYPOINTS.md` with the safe route-template grammar, `[parameter]` filesystem mapping, non-navigation rule, untrusted parameter boundary, and exact gateway ordering. Reconcile any README examples without changing public-route or sitemap behavior for private generated pages.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without generating the CRM `customer-edit` business page, weakening Shell target checks, exposing a remote implementation, or changing unrelated generated routes.

## Testing Strategy

Use Core schema unit tests for the serialized template grammar, disposable generator fixtures for
every output and failure path, and Shell unit tests for the runtime prop boundary and load ordering.
Compile generated dynamic-page fixtures against the real workspace contracts. Preserve all static
page tests as compatibility coverage and verify that every validation failure leaves the fixture
byte-for-byte unchanged.

## Acceptance Criteria

- [x] `scaffold:microvertical-page` accepts `/crm/customers/:id/edit` and generates owner/Shell files under `[lang]/crm/customers/[id]/edit`.
- [x] Canonical/localized route metadata and the serialized page contribution retain `/crm/customers/:id/edit`; parameter syntax never becomes an import, loader, function, or trusted context value.
- [x] A dynamic page is exact-target resolvable and lazy-loadable but is absent from normal module navigation.
- [x] Only declared, bounded string route parameters reach the approved remote component, after all existing authenticated Shell/Core target gates succeed.
- [x] Unsafe, ambiguous, colliding, cross-owner, partial, or developer-edited inputs fail atomically with no filesystem mutation.
- [x] Existing static generated pages, omitted-URL defaults, route metadata, navigation, localization, Module Federation wiring, and exact reruns retain their behavior.
- [x] Documentation and command help describe the dynamic URL grammar and trust boundary accurately.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the CLI, generator, helpers, and disposable-workspace tests.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — lint generator infrastructure not covered by root application lint paths.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — run all Codesmith unit and disposable-workspace integration tests.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — verify the documented dynamic URL grammar without writing.
- `mise exec -- node --test packages/core-runtime/tests/unit/shell-contribution.test.ts` — validate the safe serialized Shell page route-template contract.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate exact-target loaders, remote load ordering, and route-parameter props.
- `mise exec -- pnpm module-entrypoints:check` — prove generated and runtime page boundaries remain governed and lazy.
- `mise exec -- pnpm check:module-contracts` — validate safe serialized page contributions and owner registration identities.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This chore is required before the requested `CustomerEdit` page can use its exact URL. The current
  generator help and implementation explicitly reject `:id` parameters.
- Dynamic page route parameters are business input only. Receiving BFF schemas still validate
  `customerId`, and authenticated tenant/principal/legal-entity context still comes exclusively from
  the verified Shell boundary.
- Dynamic pages intentionally have no generated module navigation item. Contextual links from a
  Customer list/detail flow must supply a concrete Customer ID.
- This chore adds no CRM page, Customer behavior, BFF operation, database change, or UI.

## Implementation Evidence

### Summary

- Added safe dynamic page-template validation, canonical-to-filesystem mapping, collision preflight,
  non-navigation generation, and bounded untrusted route-parameter propagation through the existing
  exact Shell gateway.
- Updated command help, public documentation, and authoritative module guidance without generating
  the CRM `customer-edit` business page.

### Changed Files

17 files changed, 730 insertions(+), 96 deletions(-), including the dynamic-page implementation,
its tests and documentation, plus the narrow scaffolding validation fixes required to make every
listed command pass.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/shell-contribution.test.ts` — accepted mixed templates, plain
  serialization, and unsafe/ambiguous/repeated parameter rejection.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — exact dynamic output, compilation,
  formatting, reruns, static compatibility, collisions, developer edits, and atomic no-write paths.
- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — declared/bounded parameter
  selection, empty static parameters, and target-identity separation.
- `apps/shell-super-app/tests/unit/routes/modules/page.test.tsx` — post-resolution lazy-load ordering
  and approved remote props for dynamic and static pages.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` — supplies the Action generator's
  mandatory legal-entity scope so the fixture reaches the intended missing-contract assertion.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — passed after resolving all reported
  scaffolding findings.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — 42/42 passed, including
  formatter stability and generated-file typechecking.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — passed.
- `mise exec -- node --test packages/core-runtime/tests/unit/shell-contribution.test.ts` — 20/20
  passed, including non-configured locale-prefix regressions.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — 149/149 passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm check` — passed twice, including after the review fix.
- `mise exec -- pnpm build` — CRM server/client compilation and Module Federation DTS generation
  passed, then the existing release-envelope precondition rejected source revision `workspace`.
- Browser validation — not run: this infrastructure chore intentionally does not generate the CRM
  business page, so there is no changed user-visible runtime path to exercise.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`,
  `ULTRAMODERN.md`, `FRONTEND.md`, `MODULE_ENTRYPOINTS.md`, and `MODULE_MANIFESTS.md`; the final diff
  preserves independent deployment seams, exact target gating, typed errors, private lazy loading,
  and the `appId`/`moduleId` split.
- The review found and fixed one evidence mismatch: the disposable dynamic fixture now uses the
  specification's exact `/crm/customers/:id/edit` canonical template. A second specification review
  and standards/AGENTS review found no release blockers after generic locale-prefix coverage was
  added and an initially broad lint cleanup was narrowed to behavior-preserving changes. No
  screenshots apply.

### Deviations and Follow-ups

- No validation-command deviations remain.
- The build requires a promotable source revision instead of the worktree value `workspace`; no
  product or generator failure occurred before that environment precondition.
- Core and Codesmith retain separate implementations of the same route grammar. The review judged
  this non-blocking because sharing the validator would widen a dependency boundary and both suites
  now cover matching locale and parameter cases.
