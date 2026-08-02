---
type: feature
status: done
created: 2026-07-31
---

# Feature: Add Codesmith Generators

## Feature Description

Add four repository-owned Codesmith scaffolds for the business code types that OntOS requires developers and coding agents to generate: Actions, MicroVertical pages, Action-owned Outbox Messages, and global or MicroVertical Policies. Each root command must validate its target before writing, create the minimum useful starter files, perform only the deterministic wiring that can be inferred from its arguments, and leave a compiling, fail-closed starting point whose remaining work is business logic.

The implementation is tooling-focused. Apart from registering the commands, pinning Codesmith, adding the approved Core global-Policy export insertion point, and closing any directly exposed Core execution seam required to keep generated handlers private, it must not change existing Shell/Core application behavior. Generator integration tests must exercise generated output in disposable fixtures rather than add example business code to the application.

## User Story

As an OntOS developer or coding agent
I want mandatory scaffolding commands for Actions, MicroVertical pages, Outbox Messages, and Policies
So that new business code starts with the required Effect contracts, ownership boundaries, safe defaults, and repository wiring already in place

## Problem Statement

OntOS architecture requires these four code types to be generator-created, but the root package exposes no matching scaffold commands and `scripts/` contains no implementations. Authors must therefore reconstruct paths, names, Effect contracts, locale metadata, Action ownership, outbox producer rules, Policy scope, and exports manually. That is both error-prone and incompatible with the mandatory generator rule in `../AGENTS.md`.

## Solution Statement

Pin the already-resolved `@modern-js/codesmith` 2.6.9 release as a direct root development dependency and add a shared, non-interactive scaffold runner with four local Codesmith generator entrypoints. The runner will provide consistent `--help`, strict argument and path validation, preflighted conflict detection, deterministic naming, and mutation boundaries.

Generate one self-contained Action registration file, one typed Outbox Message schema/factory file wired to its generated Action surface, one scoped Policy file, or one page plus its colocated route metadata. Update only unavoidable existing owner files: the target vertical's package dependency and locale catalogs, route artifacts through the repository's existing route generator, the generated Action's owned export slot, and the approved Core export insertion point for global Policies. Use typed, fail-closed starter behavior where executing unfinished server code would otherwise falsely succeed.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — defines the canonical command names and makes these four generators mandatory.
- `AGENTS.md` — constrains the implementation to `app/`, protects existing Shell/Core source, and requires the repository-managed toolchain.
- `package.json` — register exactly the four scaffold scripts and directly pin Codesmith.
- `pnpm-lock.yaml` — record the direct root Codesmith dependency without unrelated lockfile churn.
- `packages/core-runtime/src/actions/definition.ts` — source contract for a generated Action descriptor and opaque registration; keep its handler private to Core.
- `packages/core-runtime/src/actions/runtime.ts` — the only execution path allowed to resolve and invoke a registered Action handler.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — proves the public registration exposes no directly callable handler.
- `packages/core-runtime/src/actions/context.ts` — source contract for handler-owned Domain Event and Outbox Message collection.
- `packages/core-runtime/src/actions/events.ts` — source contract for declared Domain Events and typed Outbox Message values.
- `packages/core-runtime/src/actions/policy.ts` — source contract for global and owner-local Policy definitions and safe denials.
- `packages/core-runtime/src/index.ts` — add only the approved stable insertion point used to export generated global Policies.
- `scripts/generate-tanstack-routes.mts` — canonical route/tree and colocated route-metadata regeneration to invoke after a page scaffold succeeds.
- `scripts/check-ultramodern-i18n-boundaries.mts` — validates generated page copy remains in the owning vertical's locale namespace.
- `scripts/validate-ultramodern-workspace.mts` — register the independently versioned Codesmith tool pin so the workspace package-source contract can validate it without treating it as part of the aliased UltraModern release cohort.
- `docs/architecture/MICROVERTICALS.md` — requires strict vertical deployment seams and a generated Effect BFF client as the only frontend/backend interface.
- `docs/architecture/ACTIONS.md` — defines Action ownership, Policy evaluation, Domain Event, Outbox Message, transaction, and evidence invariants.
- `docs/architecture/ERRORS.md` — prevents the scaffold from inventing a generic Action HTTP endpoint and requires endpoint-specific typed error mapping.
- `docs/architecture/ULTRAMODERN.md` — requires generator-first business code and forbids unsupported manual business-file creation.
- `docs/frontend/FRONTEND.md` — governs generated page structure, i18n, presentation boundaries, accessibility, and private-first behavior.

### New Files

- `scripts/scaffolding/cli.mts` — shared command parser, help output, Codesmith invocation, and page post-generation route refresh.
- `scripts/scaffolding/shared.mts` — common target identity, mutation, conflict, formatting, and safe owner-file primitives.
- `scripts/scaffolding/generator-adapter.mts` — one typed Codesmith adapter shared by all planners.
- `scripts/scaffolding/tailwind-prefix.mts` — one Tailwind federation-prefix rule shared by page generation and workspace validation.
- `scripts/scaffolding/action/scaffold.mts` — Codesmith Action entrypoint and owned planner/renderer.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — Codesmith MicroVertical page entrypoint plus page-only topology, locale, and route prerequisite discovery.
- `scripts/scaffolding/outbox-message/scaffold.mts` — Codesmith Outbox Message entrypoint and owned planner/renderer.
- `scripts/scaffolding/policy/scaffold.mts` — Codesmith global/MicroVertical Policy entrypoint and owned planner/renderer.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-fixture tests for all four commands, their wiring, and their failure paths.
- `scripts/scaffolding/tsconfig.json` — focused strict typecheck coverage for generator implementation and tests.
- `verticals/<vertical>/src/actions/<action>.action.ts` — runtime output: one self-contained typed Action registration with an owned Outbox export slot.
- `verticals/<vertical>/src/actions/<action>.<topic-slug>.outbox-message.ts` — runtime output: an Action-owned typed Outbox payload schema and message factory.
- `verticals/<vertical>/src/routes/[lang]/<page>/page.tsx` — runtime output: localized, private-first page starter.
- `verticals/<vertical>/src/routes/[lang]/<page>/route.meta.ts` — runtime output: colocated route metadata for the new page.
- `verticals/<vertical>/src/policies/<policy>.policy.ts` — runtime output for a MicroVertical-owned executable Policy.
- `packages/core-runtime/src/policies/<policy>.policy.ts` — runtime output for a Shell/Core-owned global Policy.

## Implementation Plan

### Phase 1: Foundation

Pin Codesmith, expose the four exact root commands, and build a shared runner that recognizes the required flags and `--help`. Discover vertical identity from the existing generated vertical package metadata and authoritative topology, require globally unique app IDs, accept only safe canonical identifiers, preflight every output and owner-file mutation before the first write, and reject missing targets, path traversal, duplicates, unknown flags, and attempts to overwrite business code.

Add one explicit generated-global-Policy export insertion point to the Core public index. No other existing Shell/Core source may change. Keep templates in the generator modules unless a separate template file provides a concrete maintenance benefit, so the implementation and emitted file count stay small.

### Phase 2: Core Implementation

Implement each Codesmith entrypoint and add its focused fixture tests beside the behavior:

- Action: generate one fail-closed Effect Action registration containing payload/result/domain-error schemas, an explicit empty Domain Event map, evidence policy, idempotency/audit defaults, `policies: []`, owner/action keys, and a private handler wired through `defineAction`. Ensure the vertical declares `@app/core-runtime: workspace:*` without disturbing unrelated package fields.
- Outbox Message: require an Action created by the Action generator, generate one typed payload schema and factory that fixes the exact topic and producer owner, and add a deterministic re-export in the Action's owned scaffold slot. Leave `addDomainEvent` and `addOutboxMessage` invocation to the handler's business logic because the CLI cannot infer a truthful event subject or payload.
- Policy: generate one fail-closed evaluator using `denyPolicy`. Global scope writes under Core and inserts one named public export at the approved index marker; MicroVertical scope writes under the owning vertical and remains owner-local with no cross-vertical export.
- MicroVertical page: generate one accessible presentation starter and one private/non-indexable route metadata file, then add deterministic title, description, and empty-state keys to every locale catalog already supported by the target vertical.

### Phase 3: Integration

After a page write succeeds, call the existing `scripts/generate-tanstack-routes.mts --app <app-id>` wrapper so TanStack routes and `ultramodern-route-metadata.ts` are regenerated by their owner rather than hand-edited. Keep the other generators server-only and avoid fabricating a BFF endpoint: public request/result/error/status contracts are operation-specific, and a generic Action HTTP endpoint is prohibited.

Run the four commands against copied disposable fixture workspaces in tests. Prove exact mutation boundaries, stable rerun/conflict behavior, deterministic formatting, fail-closed defaults, and that failed preflight leaves the fixture unchanged. Finish with focused generator type/lint/test checks, all four help commands, and the repository quality gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Add the Codesmith runner and command contracts

- [x] Add exact `@modern-js/codesmith: 2.6.9` root `devDependencies` pin and only these root scripts in `package.json`: `scaffold:action`, `scaffold:microvertical-page`, `scaffold:outbox-message`, and `scaffold:policy`; refresh `pnpm-lock.yaml` with no unrelated dependency upgrades.
- [x] Add `scripts/scaffolding/cli.mts`, the four local Codesmith entrypoints, and shared support so every package command invokes Codesmith from the `app/` root, accepts the issue-defined flags (including the forwarded `--` separator), and prints actionable `--help` without writing.
- [x] Validate existing `verticals/<vertical>/package.json` metadata rather than guessing a target, derive stable TypeScript identifiers and file slugs deterministically, and reject absolute paths, `..`, separators, empty values, unknown flags, invalid scope combinations, nonexistent/non-vertical packages, and existing destination files.
- [x] Precompute every file creation and existing-file patch before applying any mutation, preserve unrelated JSON/source formatting through deterministic serialization/formatting, and make all validation failures write nothing.
- [x] Add the narrowly approved generated-global-Policy export marker to `packages/core-runtime/src/index.ts`; do not change any other existing Shell/Core source file.
- [x] Begin `scripts/scaffolding/tests/scaffold-generators.test.mts` with command-help, missing/unknown argument, scope/vertical validation, traversal, overwrite, and no-partial-write cases, and add `scripts/scaffolding/tsconfig.json` so tooling code is strictly typechecked.

### 2. Implement the Action generator

- [x] Make `mise exec -- pnpm scaffold:action -- --vertical <vertical> --action <action>` generate exactly `verticals/<vertical>/src/actions/<action>.action.ts` and add `@app/core-runtime: workspace:*` to the target vertical only when absent.
- [x] Render a self-contained, immutable `defineAction` registration using the current Core fields: stable owner/action/schema keys, payload and result schemas, a declared starter domain error, explicit `domainEvents: {}` and `policies: []`, access-evidence policy, audit profile, idempotency rule, and a private Effect handler that fails with the declared not-implemented domain error until business logic replaces it.
- [x] Include one generator-owned, uniquely delimited Outbox re-export slot so the Outbox generator can extend only generated Actions without parsing or rewriting arbitrary developer code.
- [x] Add fixture tests for exact output path/content, TypeScript-safe naming, Core dependency insertion/preservation, descriptor-handler wiring, typed fail-closed behavior, empty Policy/Event defaults, and conflict-safe reruns.

### 3. Implement the Outbox Message generator

- [x] Make `mise exec -- pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>` require the matching generated Action and a safe stable dot-separated topic, then generate exactly one colocated `<action>.<topic-slug>.outbox-message.ts` file.
- [x] Define a concrete Effect payload schema, inferred payload type, exact producer module key, exact topic constant, and typed factory returning the Core `OutboxMessage` shape; keep transport, worker, persistence, and another MicroVertical's code out of the file.
- [x] Insert one deterministic named re-export into the generated Action's owned slot. Do not fabricate a Domain Event, subject resource, collector call, external side effect, or generic message registry; those values belong to the Action handler's business logic and transaction.
- [x] Add fixture tests for topic normalization, producer ownership, schema/factory output, Action-local wiring, multiple distinct messages in stable order, duplicate/topic collision rejection, missing or non-generated Action rejection, and preservation of developer-owned Action content outside the slot.

### 4. Implement the Policy generator

- [x] Make global `mise exec -- pnpm scaffold:policy -- --scope global --policy <policy>` generate one `packages/core-runtime/src/policies/<policy>.policy.ts` and insert one named export at the approved Core marker; reject `--vertical` for global scope.
- [x] Make MicroVertical `mise exec -- pnpm scaffold:policy -- --scope microvertical --policy <policy> --vertical <vertical>` generate one owner-local `verticals/<vertical>/src/policies/<policy>.policy.ts`, ensure the Core dependency exists, and add no Core, package, manifest, or cross-vertical export.
- [x] Use `defineGlobalPolicy` or `defineMicroverticalPolicy` with stable keys and a typed evaluator that denies with a safe `policy_not_implemented` reason until its business rule is filled in; preserve direct Policy object reference usage for later Action attachment.
- [x] Add fixture tests for both scopes, required/forbidden vertical combinations, exact ownership metadata, fail-closed evaluation, global named export insertion, multiple global exports, owner-local privacy, dependency preservation, and duplicate/conflict failures.

### 5. Implement the MicroVertical page generator

- [x] Make `mise exec -- pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page>` generate exactly `page.tsx` and `route.meta.ts` below `verticals/<vertical>/src/routes/[lang]/<page>/`.
- [x] Render a localized semantic page starter with its owning vertical's existing i18n namespace, `UltramodernRouteHead`, translated heading/description/empty starter copy, responsive token-based Tailwind layout, and no backend call, hardcoded user-facing text, new shared component, or unnecessary React state/effect.
- [x] Render private-first route metadata using the target app id, namespace, Module Federation boundary, canonical path, supported locales, and deterministic title/description keys; default to `public: false` and `indexable: false`.
- [x] Patch each existing target-vertical locale catalog with the same generated keys and localized starter values, reject missing/inconsistent locale or metadata prerequisites before writing, and invoke `scripts/generate-tanstack-routes.mts --app <app-id>` only after Codesmith succeeds.
- [x] Add fixture tests for exact two-file output, locale completeness, private route metadata, accessible/translated presentation, canonical route-refresh invocation, nested collision handling, preservation of unrelated locale keys, and zero Shell mutations.

### 6. Prove shared safety and architecture boundaries

- [x] Extend fixture coverage to run all four generators in realistic order against the same disposable vertical and prove their combined output is deterministic, uses direct Core references, remains inside the owning vertical/Core global-Policy boundary, and does not edit topology, Shell source, another vertical, Core internals, or generated BFF contracts/clients.
- [x] Prove `--help` and every validation failure leave no files or owner-file diffs, reruns never overwrite business code, and formatter output is stable.
- [x] Verify tests create and clean only OS-temporary fixtures; do not commit a demonstration Action, page, Outbox Message, Policy, generated route artifact, or business vertical.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` in order and resolve every failure; the required package-source validator metadata update is recorded below as the sole scope deviation.

## Testing Strategy

### Unit Tests

Use Node's test runner against temporary fixture workspaces to cover argument parsing, help, identifier derivation, path containment, vertical discovery, mutation planning, conflict detection, fail-closed template contracts, package/locale/source patch helpers, and deterministic rendering. Assert exact output rather than loose substring-only checks for security- and ownership-sensitive fields.

### Integration Tests

Invoke each local Codesmith entrypoint through the same shared runner used by the package scripts, first independently and then in Action → Outbox Message plus global/MicroVertical Policy and page combinations. Use an injectable route-refresh executor in tests to prove the selected app command without invoking the framework against the real workspace. Verify complete fixture trees and owner-file diffs, then run focused TypeScript, lint, format, and repository checks.

Do not add a browser test: the page scaffold intentionally has no data interaction, and its generated presentation/metadata/locale contract is fully covered in disposable fixtures. A real page's loading, empty, error, forbidden, validation, conflict, retry, accessibility, and responsive behavior must be implemented and tested when its actual business/data contract is known.

### Edge Cases

- A required flag is missing, repeated, empty, unknown, or supplied with an invalid `--scope` combination.
- A vertical, package metadata field, route namespace, Module Federation boundary, locale catalog, Action, or generator-owned insertion slot is absent or inconsistent.
- A name contains traversal, separators, unsupported casing/characters, reserved segments, or normalizes to a colliding file/identifier.
- The destination, generated export, locale key, dependency, page route, Action, Policy, or topic already exists.
- A global Policy request supplies a vertical, or a MicroVertical Policy request omits or targets a different vertical.
- The Outbox Message targets a handwritten/non-generated Action, a foreign producer, an invalid topic, or a duplicate normalized topic.
- One preflight check fails after other mutations have been planned; no planned write may be applied.
- Page route regeneration fails after Codesmith output; the command must report the owning failure clearly and remain safely rerunnable without overwriting generated source.

## Acceptance Criteria

- [x] All four exact commands from issue 73 exist, run from `app/` through the pinned repository toolchain, and provide accurate `--help`.
- [x] `@modern-js/codesmith` is pinned directly to `2.6.9`; the lockfile contains no unrelated upgrades.
- [x] Every command is executed by a local Codesmith generator, validates its complete mutation set before writing, stays path-contained, and refuses to overwrite existing business code.
- [x] The Action command emits one self-contained, typed, fail-closed Action registration and performs only the necessary target-vertical Core dependency update.
- [x] The Outbox Message command emits one typed Action-owned payload/factory file and wires its named export into the generated Action without inventing Domain Event or transaction data.
- [x] The Policy command emits one fail-closed Policy with correct global or same-owner MicroVertical scope; only global Policies are exported through the approved Core index insertion point.
- [x] The page command emits exactly one page and one colocated metadata file, updates every owning locale, defaults to private/non-indexable, and delegates route artifact regeneration to the existing route generator.
- [x] Generated frontend code contains no hardcoded user-facing copy, ad hoc backend access, unnecessary state/effects, plain CSS, or new shared component.
- [x] No generator crosses a MicroVertical deployment seam, exposes an executable owner-local Policy, creates a generic Action BFF endpoint, bypasses the generated Effect client seam, or fabricates an Outbox/Domain Event relationship.
- [x] Existing application changes are limited to the approved global-Policy export insertion and the Core Action registration/runtime hardening required to keep generated handlers inaccessible outside `runAction`; all other implementation files are generator/test infrastructure under `scripts/scaffolding/` plus package/tool metadata.
- [x] Disposable-fixture tests cover success, composition, duplicate/conflict, validation, traversal, ownership, fail-closed, deterministic output, and no-partial-write paths for all four generators.
- [x] All Validation Commands pass with zero regressions.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm install --frozen-lockfile` — prove the exact Codesmith pin and lockfile install cleanly with the repository-managed toolchain.
- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — strictly typecheck the generator runner, entrypoints, helpers, and tests with the repository's stable TS7 compiler.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — lint generator infrastructure that the existing root lint script does not scan.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — run all generator unit and disposable-workspace integration tests.
- `mise exec -- pnpm scaffold:action -- --help` — verify Action command discovery and documented flags without writing.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — verify page command discovery and documented flags without writing.
- `mise exec -- pnpm scaffold:outbox-message -- --help` — verify Outbox Message command discovery and documented flags without writing.
- `mise exec -- pnpm scaffold:policy -- --help` — verify Policy command discovery and documented scope rules without writing.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

### Implementation Summary

- Added one strict shared CLI and four local Codesmith 2.6.9 entrypoints for Action, Outbox Message, Policy, and MicroVertical page scaffolding.
- Added preflighted, path-contained mutation planning; authoritative topology and global app-ID validation; generated-only extension slots; fail-closed Effect templates; owner/metadata validation; deterministic package, locale, and export wiring; and page route regeneration.
- Made Action registrations opaque by storing handlers outside the exported registration object and resolving them only inside Core `runAction`.
- Added sixteen disposable-workspace test groups covering command contracts, exact outputs, failures, topology/identity collisions, normalized identifier collisions, ownership, composition, recoverable route refresh, formatter stability, generated-output compilation, and mutation boundaries. No example business vertical or generated business artifact was added to the workspace.

### Changed Files

- `package.json`, `pnpm-lock.yaml` — exact command scripts, Codesmith 2.6.9 pin, and focused Node types required by the standalone tooling typecheck.
- `packages/core-runtime/src/index.ts` — approved empty generated-global-Policy export slot.
- `packages/core-runtime/src/actions/{definition,runtime}.ts` — opaque private-handler storage and Core-only execution lookup.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — public handler-opacity regression coverage.
- `scripts/validate-ultramodern-workspace.mts` — exact standalone Codesmith metadata and validation, kept separate from the aliased UltraModern package cohort.
- `scripts/scaffolding/**` — CLI, shared planning/rendering, four Codesmith entrypoints, strict tooling tsconfig, and fixture tests.

### Tests Added

- `scripts/scaffolding/tests/scaffold-generators.test.mts` — 16 passing test groups covering all four generators independently and together, help/argument behavior, topology identity, preflight/no-write failures, stable slots and ordering, locale and route wiring, fail-closed templates, cross-owner protection, formatter stability, and compilation against real workspace contracts.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — proves callers receive an immutable descriptor registration without a callable handler property.

### Validation Results

- `mise exec -- pnpm install --frozen-lockfile` — passed with the repository-managed toolchain and a temporary writable UltraModern skills root.
- Focused generator TypeScript, oxlint, and Node tests — passed; 16 tests, 0 failures.
- Core Action unit tests — passed; 48 tests, including public handler opacity and permission/runtime behavior.
- Live PostgreSQL/SpiceDB Action integration tests — passed; 16 tests covering allowed, denied, unavailable, Policy, concurrency, and rollback paths.
- All four scaffold `--help` commands — passed without writes.
- `mise exec -- pnpm check` — the full chain passed: formatting, repository lint, 48 Core Action unit tests, workspace typecheck, skills check, i18n/API boundaries, workspace contract validation, and performance readiness. The read-only/incomplete `.agents` and `.codex` sandbox paths were supplied through a disposable mirror for metadata checks and report output; application and generator source remained the implemented workspace tree.
- Browser validation was not run because the feature emits no real route and the Core hardening is server-only.

### Final Review

- Re-read both agent instruction files and all required app-local architecture/frontend guidance after implementation.
- Confirmed the final diff contains no business Action, Outbox Message, Policy, page, route artifact, vertical, BFF endpoint/client, database change, or Shell application source change; the only Core behavior change removes direct handler access.
- Confirmed generated global Policies import their owning Core policy module directly, while MicroVertical outputs use only the narrow public Core surface and never import another vertical.

### Deviations

- The root workspace validator originally rejected any direct `@modern-js/*` dependency outside the aliased UltraModern release cohort. Codesmith 2.6.9 is independently versioned, so the validator now records and enforces it as an exact standalone Modern tool. This required the sole additional existing-file change beyond the originally listed three files.
- Added the already-resolved exact `@types/node` 20.19.43 root development dependency because pnpm's strict dependency isolation prevented the standalone tooling tsconfig from resolving Node types through another package.
- Used the repository's stable TS7 `tsc` executable for the focused tooling typecheck; the installed `@effect/tsgo` package is a setup utility rather than the compiler executable.

## Notes

- Issue 73 is classified as a Feature because it adds a new supported developer workflow and enforces the required starting point for future business functionality.
- The repository currently has no `verticals/*` package, so implementation tests must use disposable generated-shape fixtures and must not add a sample business vertical.
- `@modern-js/codesmith` 2.6.9 is already present transitively in `pnpm-lock.yaml`; the implementation makes that exact release a direct root development dependency so generator availability is intentional and stable.
- The Action scaffold uses the target vertical's generated app id as `owningModuleKey` and as the Action-key prefix. It does not invent the not-yet-implemented OntOS Module Manifest described in older repository context.
- An Outbox Message must reference a real Domain Event created by the same Action execution. Because `--vertical`, `--action`, and `--topic` do not provide a truthful subject resource or event payload, the generator prepares the typed message and Action-local wiring but deliberately leaves collector invocation to business logic.
- Action BFF request/success/error schemas and HTTP statuses are business-operation-specific. Generating a generic endpoint would violate `docs/architecture/ERRORS.md`, so the Action generator stops at a server-only registration ready for an owning endpoint to call.
- The mandatory generator-first rule does not require running these commands before they exist. Implementation creates no business Action, page, Outbox Message, or Policy in the real workspace; once implemented, all disposable test outputs are created through the matching generator.
- Repository-level `../docs/03_ARCHITECTURE_OVERVIEW.md` and ADR-0001 describe V0 MicroVerticals as jointly deployed, while authoritative `app/docs/architecture/MICROVERTICALS.md` requires strict independent deployment seams. This plan follows the app-local rule as required by `AGENTS.md`.
- No unresolved developer decision blocks implementation.
