---
type: chore
status: done
created: 2026-08-10
---

# Chore: CRM 01 Action Codesmith boundary

## Chore Description

Implement ticket 1, "Correct the Codesmith Action boundary," from `app/tickets.md`. Refactor the
Action scaffold so one generated Action owns its typed payload, result, declared domain-error and
event schemas, immutable descriptor, Action-specific strict Effect HTTP transport/client, manifest
publication, and owner-private registration binding point without generating any private handler,
placeholder handler, or `NotImplemented` behavior. Preserve existing Core Action behavior while
making a manually authored owner-local Effect handler the only source of CRM business behavior.

## Relevant Files

Use these files to accomplish the chore:

- `specs/feature-crm-microvertical.md` — authoritative CRM scope and approved Action/authoring boundary.
- `tickets.md` — corresponding ticket 1 and its acceptance criteria; blockers: none.
- `scripts/scaffolding/action/scaffold.mts` — current Action scaffold that emits a private `NotImplemented` handler.
- `scripts/scaffolding/cli.mts` — existing `scaffold:action` help and required ownership/legal-entity flags.
- `scripts/scaffolding/shared.mts` — atomic mutations, containment checks, generated slots, and owner discovery.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable generator, rerun, safety, and compilation fixtures.
- `packages/core-runtime/src/actions/definition.ts` — current combined descriptor/handler registration seam to split without weakening opacity.
- `packages/core-runtime/src/actions/runtime.ts` — resolves private handlers only after context, module-state, permission, Policy, and transaction gates.
- `packages/core-runtime/src/modules/manifest.ts` — serializes safe Action descriptor data without private implementation.
- `packages/core-runtime/src/modules/runtime-registration.ts` — owner-private runtime binding and descriptor identity checks.
- `docs/architecture/ACTIONS.md` — mandatory Action lifecycle and atomicity rules.
- `docs/architecture/ERRORS.md` — complete typed Action/BFF error mapping requirements.
- `docs/architecture/MODULE_MANIFESTS.md` — public descriptor versus private registration boundary.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Lock the approved output contract with failing generator tests

- [x] Update `scripts/scaffolding/tests/scaffold-generators.test.mts` first to assert that a generated MicroVertical Action contains schemas and an immutable public descriptor, creates Action-specific files under the established `shared/apis/`, `api/`, and `src/api/` strict Effect topology, patches the manifest and private registration atomically, exposes an owner-private binding point, and contains no handler function, `NotImplemented` error, placeholder implementation, or browser-visible private binding.
- [x] Cover `--help`, required `--legal-entity-scope`, stable reruns, sorted slot composition, existing developer-owned content, traversal/cross-owner rejection, identifier collisions, no partial writes, formatting, and compilation of a disposable fixture whose manually authored handler binds successfully.

### 2. Separate the public Action contract from private handler binding

- [x] Refactor `packages/core-runtime/src/actions/definition.ts` so a generated immutable Action contract can exist without a handler, while a one-time owner-local binding associates the manually authored `ActionHandler` and scoped service factory through private weak-map state. Keep handler/service values absent from the public object, manifest, serialization, and browser surface.
- [x] Preserve the existing `defineAction` path for current Core-owned Actions or migrate it mechanically to the new primitives in the same change; duplicate bindings, owner/descriptor mismatches, and execution without an owner-local binding must fail closed.
- [x] Update `packages/core-runtime/src/actions/runtime.ts`, `packages/core-runtime/src/modules/manifest.ts`, and `packages/core-runtime/src/modules/runtime-registration.ts` only as required to validate that the public descriptor and private bound registration are the same owner/action identity and to resolve the handler at the existing late runtime stage.
- [x] Add focused Core unit tests beside these changes for descriptor immutability, one-time binding, missing-binding failure, handler opacity, safe manifest extraction, and unchanged Action lifecycle ordering.

### 3. Generate the complete Action-specific Effect transport

- [x] Refactor `scripts/scaffolding/action/scaffold.mts` so `mise exec -- pnpm scaffold:action -- --vertical <vertical> --action <action> --legal-entity-scope <scope>` creates the descriptor/schemas, strict `HttpApi` endpoint contract, exhaustive Problem Details schemas, receiving server adapter, generated Effect client, and deterministic aggregate/registration wiring in the repository's current direct strict Effect topology.
- [x] Ensure the generated server adapter verifies the owner deployment's Shell assertion, invokes the exact Action through Core runtime, and exhaustively maps structural validation, authentication, permission, Policy, not-found/domain, conflict, semantic rejection, unavailable/indeterminate, and caught-defect outcomes to declared schemas and correct statuses.
- [x] Ensure the generated client preserves declared backend, transport, and decode errors in its Effect error channel and obtains a fresh audience-scoped assertion per attempt through the generated operation gateway.
- [x] Do not add a generic mutation endpoint, persistence generator, separate Action-transport generator, or any generated private business implementation.

### 4. Prove composition and isolation

- [x] Extend generator fixtures to bind a manually authored owner-local Effect handler and scoped service factory, execute the generated Action-specific endpoint/client contract, and prove private code is absent from manifest serialization and browser exports.
- [x] Retain Action, module-entrypoint, API, and database boundary tests so the new split does not permit direct handler calls, eager private loading, executor access, or cross-owner imports.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

Use generator golden/fixture tests for output and safety, Core unit tests for contract/binding opacity
and invariants, and a disposable generated strict Effect API fixture for end-to-end contract,
server, client, manual handler binding, and browser-surface isolation. Existing Action runtime tests
must continue to prove idempotency, authorization ordering, typed failures, and transaction behavior.

## Acceptance Criteria

- [x] Generated Actions contain the approved typed contract, Action-specific Effect transport/client, manifest wiring, and owner-private binding point.
- [x] No generated file contains a private handler, placeholder handler, `NotImplemented` error/handler, or business behavior.
- [x] A manually authored private handler and owner-local scoped service factory bind without becoming public or browser-reachable.
- [x] Generator help, rerun, composition, containment, cross-owner, no-partial-write, formatting, type, and generated-compilation tests pass.
- [x] Existing Core Actions and the canonical Action lifecycle remain behaviorally compatible.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the scaffold and generated fixture support.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — validate Action output, transport, binding, safety, and compilation.
- `mise exec -- pnpm action:test:unit` — validate Core Action definition/runtime behavior.
- `mise exec -- pnpm api:check` — validate the direct strict Effect API topology.
- `mise exec -- pnpm module-entrypoints:check` — validate Action descriptor and private registration boundaries.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: none; ticket 1 may run in parallel with ticket 2, but generators must not be run concurrently in one working tree.
- This ticket changes only the Action contract/transport/binding boundary. CRM schemas, repositories, services, migrations, and business handlers belong to later owner-local tickets.
- Policies and Outbox Messages remain generated only when a later capability actually declares them; this chore does not create either.

## Implementation Evidence

### Summary

- Split immutable public Action contracts from one-time owner-private handler/service bindings while preserving `defineAction` compatibility for existing Core Actions and the canonical late-resolution lifecycle.
- Expanded `scaffold:action` to atomically generate typed Action/domain contracts, strict Action-specific Effect HTTP contracts, server adapters, clients, manifest/API slots, and private binding seams without generated business behavior.
- Declared and validated Action transport headers, mapped malformed and structurally invalid requests through each endpoint's RFC 9457 schema, and replaced Policy reason-code suffix inference with explicit Action-owned status declarations.
- Generated Core binding seams, kept the Action identity-boundary prerequisite separate, and consolidated generated Action error classification into one exhaustive table.

### Changed Files

- 12 tracked files changed: 1,488 insertions and 255 deletions at final review time.
- Added the 54-line Modern.js BFF compatibility patch under `patches/` and this implementation specification under `specs/`.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/action-definition.test.ts` — proves immutable unbound contracts, one-time private binding with a mandatory scoped service factory, missing binding failure, handler opacity, and forged-copy rejection.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — proves private behavior resolves only after canonical runtime gates and missing bindings fail closed without leaking details or flushing business evidence.
- `packages/core-runtime/tests/unit/module-manifest.test.ts` — proves unbound contracts publish safe descriptors while runtime registration requires the exact owner-local bound identity.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — proves malformed-body and header validation Problem Details, explicit 403/409/422 Policy mappings, unmapped Policy fail-closed behavior, Core and MicroVertical binding seams, separate identity-boundary generation, endpoint/client execution, formatter stability, and real-workspace compilation.

### Validation

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — passed, 29/29 tests.
- `mise exec -- pnpm action:test:unit` — passed, 60/60 tests.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check` — passed; rerun after the final evidence update.
- `mise exec -- pnpm build` — passed, including Shell client/server build, TS-Go compile, Module Federation type validation, and performance readiness.

### Review

- Reviewed the complete task diff against `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `DATA_ACCESS.md`, `MODULE_ENTRYPOINTS.md`, `MODULE_MANIFESTS.md`, and `ULTRAMODERN.md`, plus the CRM feature specification and ticket 1.
- Fixed the follow-up review findings: structural decoding now uses declared Problem Details, correlation metadata is contract-required, Policy semantics are explicit and fail closed, Action error classification has one exhaustive source, owner-local bindings require service factories, Core scaffolding exposes a private binding seam, and Action generation no longer invokes the identity-boundary generator.
- Reviewed the Modern.js compatibility patch for collateral behavior; malformed JSON still reaches HttpApi as a 400 for endpoints without custom schema middleware, while generated Actions transform it to their declared 400 Problem schema.
- No UI work or screenshot review was applicable.

### Deviations and Follow-ups

- Remove `patches/@bleedingdev__modern-js-plugin-bff@3.5.0-ultramodern.96.patch` after the upstream BFF runtime forwards malformed JSON to Effect HttpApi without preempting endpoint schema-error middleware.
