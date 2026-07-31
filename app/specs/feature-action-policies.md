---
type: feature
status: done
created: 2026-07-31
---

# Feature: Action Policy Enforcement

## Feature Description

Add first-class Policy references to typed Actions and enforce those Policies in the Core Action runtime before a private Action handler can start. A Policy is an immutable referenced object, scoped either globally to Shell/Core or to one owning MicroVertical. Global Policies may be attached to any Action; a MicroVertical Policy may be attached only to an Action owned by the same MicroVertical.

Every declared Policy is evaluated against the decoded payload and trusted execution context after the invocation has been durably prepared, but before the invocation becomes `running` and before the business transaction opens. A denied Policy returns a declared typed Effect error carrying a safe human-readable reason, prevents the handler from running, and atomically finalizes the invocation as `rejected` with policy-stage audit evidence.

## User Story

As an OntOS module developer
I want every Action to reference and enforce its applicable global and module-owned business Policies
So that disallowed state changes are stopped consistently, reported safely, and retained as durable evidence without crossing MicroVertical boundaries

## Problem Statement

The Action runtime currently exposes only a deferred policy stage. `ActionDescriptor` cannot reference Policy objects, no Policy contract distinguishes global from MicroVertical ownership, and `runAction` always advances an accepted invocation toward handler execution after the deferred boundary. Consequently, business policy checks cannot be declared or enforced centrally, and a policy denial cannot produce the required typed error, rejected invocation state, or audit trail.

The current general rollback rule also deliberately leaves failed invocations open and persists no failure evidence. Policy denial is different: it occurs before the business transaction and must be durably terminalized as a rejection even though the handler never runs.

## Solution Statement

Introduce a narrow, server-only Policy contract in `@app/core-runtime` with immutable constructors for global and MicroVertical Policies. Each Policy carries a stable key, scope/owner metadata, and a dependency-closed Effect evaluator that either allows execution or fails with a declared policy denial containing a stable reason code and safe message. Extend `ActionDescriptor` with a required readonly array of Policy object references. Use TypeScript generics plus runtime definition validation to allow global references and same-owner MicroVertical references while rejecting cross-MicroVertical references and raw string keys.

Replace the deferred policy boundary in `runAction` with ordered, fail-fast evaluation after invocation preparation and the still-deferred permission boundary, but before the `received`-to-`running` transition. On denial, return a transport-neutral `ActionPolicyDenied` error whose existing `reason` convention carries the safe policy message, and use a Core repository transaction outside the business transaction to atomically mark the invocation `rejected`, set `completed_at`, and write `action.policy_checked` plus terminal `action.rejected` Audit Events. Record allowed Policy checkpoints as part of the existing successful business transaction. Sanitize unexpected evaluator defects into a typed policy-evaluation error and never execute the handler after any Policy failure.

## Relevant Files

Use these files to implement the feature:

- `docs/architecture/ACTIONS.md` — Replace the deferred policy increment with the enforced Policy lifecycle and document the denial-evidence exception to general rollback behavior.
- `docs/architecture/MICROVERTICALS.md` — Clarify that executable MicroVertical Policies remain owner-local while Core global Policy references are the only cross-module policy exception.
- `docs/architecture/ERRORS.md` — Require exhaustive endpoint mapping of the new transport-neutral policy errors without assigning one incorrect HTTP status to every possible business-policy meaning.
- `packages/core-runtime/src/actions/definition.ts` — Add required referenced Policies to Action descriptors, preserve literal owner typing, freeze the Policy collection, and reject invalid ownership at definition time.
- `packages/core-runtime/src/actions/errors.ts` — Add the safe typed denial and evaluation-failure errors to the exhaustive Core Action error union and transport-mapping guidance.
- `packages/core-runtime/src/actions/runtime.ts` — Evaluate referenced Policies before `running`/handler execution, preserve stage ordering, collect allowed decisions for success evidence, and finalize denials.
- `packages/core-runtime/src/actions/repository.ts` — Atomically persist Policy denial evidence and rejected invocation state, and persist allowed Policy checkpoints with successful Action evidence.
- `packages/core-runtime/src/index.ts` — Publish only the Policy definition/types and public typed errors required by server-side Action registrations.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — Prove descriptors accept referenced Policy objects, reject strings/cross-owner references, and remain immutable.
- `packages/core-runtime/tests/unit/action-errors.test.ts` — Prove the stable exhaustive Policy error tags and safe message contract.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — Prove evaluation order, short-circuiting, stage order, denial finalization, defect sanitization, and handler non-execution with controlled collaborators.
- `packages/core-runtime/tests/unit/action-public-surface.test.ts` — Prove the narrow server-only Policy surface and keep repository internals private.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — Prove PostgreSQL atomicity for allowed checkpoints and denied rejection/audit evidence.

### New Files

- `packages/core-runtime/src/actions/policy.ts` — Immutable global/MicroVertical Policy contracts, ownership metadata, evaluator context, and definition helpers.
- `packages/core-runtime/tests/unit/action-policy.test.ts` — Focused Policy construction, scope, ownership, evaluation, and immutability tests using test-local Policy objects.

## Implementation Plan

### Phase 1: Foundation

Define the Policy object and denial decision contracts, extend the Action descriptor with required Policy references, and enforce global-versus-owner-local attachment rules at both compile time and Action-definition time. Add the transport-neutral Core Action errors and public server-side exports without adding a production Policy or exposing executable Policies to browser Module Federation surfaces.

### Phase 2: Core Implementation

Evaluate Policies sequentially at the existing policy boundary before the invocation becomes `running`. Preserve a typed Effect error channel for expected denial/evaluation failures, sanitize defects, and add repository operations that atomically persist the rejected invocation and required audit evidence. Extend successful Action persistence with allowed Policy checkpoints while preserving the existing business transaction and idempotency marker.

### Phase 3: Integration

Exercise both global and same-owner MicroVertical-shaped Policies through the common runtime contract, prove that cross-MicroVertical references cannot be registered, and validate real PostgreSQL behavior for denial, evidence atomicity, retry/terminal state, and successful execution. Update authoritative application documentation to distinguish pre-execution rejection evidence from rolled-back handler failures.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the server-only Policy contract

- [x] Add `packages/core-runtime/src/actions/policy.ts` with immutable `global` and `microvertical` Policy object variants, stable Policy/reason identifiers, a safe human-readable denial message, typed decoded-payload/trusted-context evaluator input, and definition helpers that preserve literal owning-module types.
- [x] Keep evaluators as dependency-closed Effect programs assembled by the owning server adapter; do not expose a business transaction executor, database schema, repository, HTTP response, or cross-MicroVertical implementation through the Policy contract.
- [x] Add `packages/core-runtime/tests/unit/action-policy.test.ts` beside the contract to prove scope/owner metadata, typed allow and deny outcomes, safe denial messages, and immutable definitions with test-local Policies only.

### 2. Require referenced Policy objects on every Action

- [x] Extend `ActionDescriptor` and `defineAction` in `packages/core-runtime/src/actions/definition.ts` with a required readonly `policies` collection whose payload and literal owner types are compatible with the Action.
- [x] Permit globally scoped Policies and MicroVertical Policies whose owner exactly equals `owningModuleKey`; reject a Policy owned by another MicroVertical through the type contract and a fail-fast definition invariant so casts or untyped inputs cannot bypass the deployment seam.
- [x] Require direct Policy object references rather than keys, names, registries, or lookup strings, and freeze the copied Policy collection without mutating the referenced immutable Policies.
- [x] Update every existing test-local `defineAction` registration with an explicit `policies: []` or a relevant test Policy, and extend `packages/core-runtime/tests/unit/action-definition.test.ts` with accepted global/same-owner references, rejected cross-owner references, rejected string references, and immutability coverage.

### 3. Add typed Core policy failures

- [x] Add `ActionPolicyDenied` to `packages/core-runtime/src/actions/errors.ts` with the stable Core tag/code, policy reason code, and safe `reason` field carrying the human-readable Policy message; do not include payloads, secrets, internal identifiers, stack traces, or HTTP status in the runtime error.
- [x] Add a separate sanitized `ActionPolicyEvaluationError` for an evaluator defect or unavailable required Policy capability so operational failures are not misreported as business denials.
- [x] Include both errors in `ActionCoreError`, `ACTION_CORE_ERROR_TAGS`, exports, JSDoc transport guidance, and `packages/core-runtime/tests/unit/action-errors.test.ts`; document that a BFF maps denial according to the Policy's declared semantics (for example `403`, `409`, or `422`) and maps a temporary evaluation capability failure appropriately instead of using a universal status.

### 4. Enforce Policies before handler execution

- [x] Replace `policy_boundary_deferred` in `packages/core-runtime/src/actions/runtime.ts` with real sequential Policy evaluation after payload/context/invocation validation and the deferred permission boundary, but before `transitionInvocationToRunning`, the business transaction, collector creation, or handler call.
- [x] Evaluate Policies in descriptor order and stop on the first denial. Advance to `running` only after every referenced Policy allows the Action; an empty Policy collection remains a valid explicit declaration.
- [x] Build evaluator input exclusively from the decoded payload, trusted principal context, sanitized transport/target metadata, and Action identity. Never let payload data override trusted identity or let a Policy obtain another MicroVertical's private service.
- [x] Preserve the denied Policy's stable code and safe message in `ActionPolicyDenied`; sanitize dies, interrupts, and undeclared evaluator failures to `ActionPolicyEvaluationError` with full causes only in correlation-aware operational logs.
- [x] Update `packages/core-runtime/tests/unit/action-runtime.test.ts` to prove exact stage prefixes on denial/failure, ordered checks, first-denial short-circuiting, no transition to `running`, no transaction/collector/handler execution, fresh evaluation on separate invocations, and normal execution only when all Policies allow.

### 5. Persist allowed and denied Policy evidence

- [x] Add a private repository input and operation in `packages/core-runtime/src/actions/repository.ts` that opens one Core-owned transaction, locks/rechecks the invocation, transitions a still-open `received` invocation to `rejected` with `completed_at`, and writes a denied `action.policy_checked` checkpoint plus terminal `action.rejected` Audit Event with `outcome_stage = 'policy'` and the Policy reason code.
- [x] Keep denial evidence small and redacted: include the Action key, Policy key/scope, and owner where applicable, but no raw payload, returned message, credentials, or evaluator failure cause.
- [x] Make rejection persistence atomic and idempotency-safe: no partial Audit Event or rejected status may survive a failed finalization; a concurrent attempt must not overwrite a `running` or `succeeded` invocation or create duplicate terminal evidence.
- [x] Extend successful evidence flushing to persist one `action.policy_checked`/`allowed` checkpoint per evaluated Policy in the same business transaction as `action.executed`, business writes, events/outbox, and the invocation `succeeded` marker. Actions with no Policies keep their current success evidence shape.
- [x] If required denial persistence fails, return the existing typed persistence failure rather than claiming a durable policy rejection; still guarantee that the handler is not executed.
- [x] Extend controlled unit collaborators to prove the exact finalization input, allowed evidence handoff, persistence-failure behavior, and absence of business-transaction writes on denial.

### 6. Prove PostgreSQL behavior and boundary enforcement

- [x] Extend `packages/core-runtime/tests/integration/action-runtime.test.ts` with a denied global Policy and a denied same-owner MicroVertical-shaped Policy; assert the returned typed error includes the safe reason, the invocation is `rejected` with `completed_at`, the two policy-stage Audit Events exist, and the handler's test business mutation, Data Access Events, Domain Events, and Outbox Messages do not exist.
- [x] Add allowed-Policy coverage proving the check runs before the handler and its allowed checkpoint commits atomically with the existing success evidence and `succeeded` invocation state.
- [x] Inject denial Audit insert and invocation-update failures to prove the rejection transaction rolls back completely and still never executes the handler.
- [x] Cover repeated/concurrent use of one idempotency key so a rejection is terminal, terminal evidence is not duplicated, and no losing attempt can replace a running or successful invocation with `rejected`.
- [x] Use Shell/Core and MicroVertical-shaped test registrations only; do not add a production Action, production Policy, MicroVertical schema, or cross-MicroVertical implementation import.

### 7. Publish and document the narrow integration surface

- [x] Export the Policy constructors/types plus new public errors from `packages/core-runtime/src/index.ts`, keep repository/finalization helpers private, and extend `packages/core-runtime/tests/unit/action-public-surface.test.ts` to prevent accidental browser or infrastructure exposure.
- [x] Update `docs/architecture/ACTIONS.md` with Policy object references, scope rules, evaluation order, denial terminalization, allowed/denied audit behavior, and the explicit exception from the current rule that handler failures leave invocations open without failure evidence.
- [x] Update `docs/architecture/MICROVERTICALS.md` to prohibit MicroVertical Policy reuse/import across vertical seams while allowing the documented Core global Policy contract.
- [x] Update `docs/architecture/ERRORS.md` so future generated Action BFF endpoints map `ActionPolicyDenied` and `ActionPolicyEvaluationError` exhaustively to declared Problem Details schemas/statuses; do not add a generic Action endpoint or change the unrelated authentication API.

### 8. Run all validation commands

- [x] From `app/`, execute every command under `Validation Commands` in order and resolve all failures without weakening Policy ownership, typed Effect errors, audit atomicity, or existing Action guarantees.

## Testing Strategy

### Unit Tests

Use test-local immutable Policies and controlled runtime/repository collaborators to verify Policy construction, Action attachment typing and runtime ownership guards, global and same-owner acceptance, cross-owner/string rejection, ordered fail-fast evaluation, safe typed messages, evaluator defect sanitization, denial finalization inputs, allowed evidence handoff, handler non-execution, and the narrow public surface. Typecheck assertions must prove the owner and payload relationships that runtime tests cannot express.

### Integration Tests

Run the existing Action runtime integration suite against PostgreSQL. Prove that a denied Policy atomically creates a terminal rejected invocation and the required policy Audit Events outside the business transaction while persisting no handler-side state/evidence. Prove allowed checkpoints participate in the successful business transaction, forced rejection persistence failures leave no partial evidence, and repeated/concurrent idempotent attempts cannot duplicate or overwrite terminal state.

### Edge Cases

- An Action explicitly declares no Policies.
- An Action references one or multiple global Policies.
- A MicroVertical Action references global Policies plus Policies owned by the same MicroVertical.
- A Shell/Core or MicroVertical Action attempts to reference a Policy owned by another MicroVertical.
- A raw Policy key/string is supplied instead of a referenced object.
- Policies allow in declared order.
- The first, middle, or last Policy denies and later Policies are not evaluated.
- A Policy returns a safe message containing Unicode or user-locale text while its reason code remains stable.
- A Policy evaluator dies, is interrupted, or reports a required capability failure.
- Denial Audit insertion or rejected invocation update fails.
- Two requests with one idempotency key evaluate Policies concurrently.
- An invocation becomes `running` or `succeeded` before a losing denial finalizer obtains its lock.
- An allowed Policy is followed by a typed handler/domain rejection; no success evidence or handler transaction data commits.

## Acceptance Criteria

- [x] Every Action descriptor has an explicit readonly array of referenced immutable Policy objects; Policy names or lookup strings are not accepted.
- [x] Policies have either global Shell/Core scope or one MicroVertical owner, and a MicroVertical Policy cannot be attached to an Action owned by another MicroVertical.
- [x] Every referenced Policy is evaluated in descriptor order before the invocation becomes `running`; evaluation stops at the first denial, and the handler runs only when all Policies allow.
- [x] A Policy denial returns `ActionPolicyDenied` through the typed Effect error channel with a stable reason code and the Policy's safe human-readable message.
- [x] A denied Policy never opens the business transaction or executes the handler and persists no business mutation, Data Access Event, Domain Event, or Outbox Message.
- [x] A denied invocation is atomically marked `rejected` with `completed_at` and has denied `action.policy_checked` plus terminal `action.rejected` Audit Events at the `policy` stage.
- [x] A rejection persistence failure leaves no partial rejected status or Audit Event, returns a typed persistence failure, and still does not execute the handler.
- [x] Allowed Policy checkpoints commit only with the successful Action transaction and identify the evaluated Policy without storing payloads or secrets.
- [x] Unexpected Policy evaluator failures are sanitized into a declared typed Effect error and logged with correlation context; defects never escape as untyped failures.
- [x] Existing Actions with `policies: []`, idempotency, success atomicity, rollback, commit resolution, and strict MicroVertical boundaries continue to behave as before.
- [x] No production Policy, production Action, generic BFF endpoint, browser-exposed evaluator, new Core table, or migration is introduced by this infrastructure feature.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Run focused Action/Policy descriptor, error, runtime, ownership, and public-surface tests.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — Prove the Policy/Action owner and payload constraints with the repository TS7 toolchain.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — Prove Policy rejection and success evidence behavior against PostgreSQL.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Issue 72 is classified as a Feature because it adds a new enforceable Action capability and durable rejection behavior.
- Policy evaluation is deliberately sequential and fail-fast in descriptor order. “All Policies must be checked” means every referenced Policy is enforced before handler execution unless an earlier denial has already made later checks unnecessary.
- `ActionPolicyDenied.reason` is the existing Core Action convention for the safe human-readable message requested by the issue. Stable machine behavior uses the separate Policy reason code.
- No universal HTTP status is assigned inside Core: a principal-based denial, current-state conflict, and semantic ineligibility can map to different declared BFF Problem Details (`403`, `409`, or `422`). This repository has no production Action BFF endpoint yet, so this feature updates the exhaustive translation contract and leaves the concrete mapping with each generated Action endpoint.
- The existing Core schema already supports `rejected` invocations, `completed_at`, `allowed`/`denied` Audit outcomes, and the `policy` outcome stage, so no schema or migration change is planned.
- The mandatory `scaffold:policy` generator applies to the first production global or MicroVertical Policy. This feature adds only the shared Policy infrastructure and test-local Policy objects, so it does not scaffold a production Policy. The currently tracked root `package.json` does not expose the command named by `../AGENTS.md`; that mismatch must be resolved before a later task creates the first production Policy, but it does not block this infrastructure implementation.
- The local `.mise.toml` is currently untrusted, so repository-managed validation commands will require the developer to trust it before implementation validation. Planning did not mutate that external trust state.
- Permission enforcement remains deferred and retains its existing stage. This feature replaces only the policy boundary.
- A Policy evaluator capability failure is not a business denial: it returns the typed evaluation error, leaves the invocation open for a safe retry under the existing failure rules, writes no denied checkpoint, and never executes the handler.

## Implementation Evidence

### Summary

- Implemented immutable global and owner-local Policy references, required typed Action attachments, sequential fail-fast runtime enforcement, safe typed Policy failures, atomic denial terminalization, transactional allowed checkpoints, narrow public exports, architecture documentation, and focused unit/integration coverage.
- Restored the ignored agent-skills lock/license metadata in the isolated issue worktree, installed its pinned skills, and resolved the four repository Effect diagnostics that blocked the final gate.
- All focused tests, plan validation commands, PostgreSQL verification, the complete repository quality gate, and the production build pass.

### Changed Files

The final tracked diff changes 16 files with 1,223 insertions and 27 deletions. Three new files add 456 lines: `packages/core-runtime/src/actions/policy.ts`, `packages/core-runtime/tests/unit/action-policy.test.ts`, and this specification. Across 19 files, the total is 1,679 insertions and 27 deletions. The final validation cleanup also updates two Node-only Effect diagnostic declarations and replaces JSON serialization with direct ordered-array comparison in Core database verification. No dependency lockfile, schema, or migration changed.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/action-policy.test.ts` — Policy construction, scope/owner metadata, typed allow/deny outcomes, safe Unicode denial messages, constructor guards, and immutability.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — required references, payload/owner typing, global/same-owner acceptance, string/copied/cross-owner rejection, and frozen copied collections.
- `packages/core-runtime/tests/unit/action-errors.test.ts` — stable exhaustive Policy error tags, codes, safe reasons, and absence of transport/internal data.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — stage/order enforcement, short-circuiting, sanitized defects/interrupts/undeclared failures, denial finalization, persistence failure, fresh evaluation, handler non-execution, and allowed evidence handoff.
- `packages/core-runtime/tests/unit/action-public-surface.test.ts` — narrow Policy/error exports and private repository/finalization internals.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — allowed checkpoint atomicity; denied global and same-owner MicroVertical evidence; audit/update rollback; terminal retry/concurrency; and protection of running/succeeded invocations.

### Validation

- `MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm skills:install` — passed after restoring the ignored worktree-local skills lock; all pinned public/private-when-authorized skills installed.
- `MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed, 36 tests.
- `MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm --filter @app/core-runtime typecheck` — passed after explicitly documenting the Node-only path-import exceptions and replacing JSON serialization comparison with direct ordered-array comparison.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm --filter @app/core-runtime action:test:integration` — passed, 11 PostgreSQL tests.
- `MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm check` — passed formatting, lint, 36 Action unit tests, repository typechecking, skills verification, i18n boundaries, API boundaries, workspace contract validation, and performance readiness.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm --filter @app/core-runtime db:verify` — passed; verified all 18 typed Core tables against PostgreSQL.
- `MISE_TRUSTED_CONFIG_PATHS=<app>/.mise.toml mise exec -- pnpm build` — passed, including the Modern build, TS-Go compilation, Module Federation type generation, and performance readiness.
- `git diff --check` — passed.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, the complete specification, `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `DATABASE.md`, `ULTRAMODERN.md`, and the relevant Core/runtime/action/database source and tests.
- Final review found and corrected completion-time sampling so a denied invocation records the timestamp at the locked database update rather than before lock acquisition. No cross-MicroVertical implementation import, Action lifecycle bypass, undeclared runtime failure, browser exposure, raw SQL, new schema/migration, production Policy/Action, generic endpoint, or unexplained tracked change remains. No screenshots apply because this is server-only infrastructure.

### Deviations and Follow-ups

- The worktree-local `.codex` skills lock, license, and installed skills are ignored setup metadata and are not part of the tracked feature diff.
- The two Node `path` imports remain intentional in synchronous Node-only initialization modules and now carry explicit `nodeBuiltinImport:off` Effect diagnostic declarations.
- No Codesmith generator was run because this feature adds shared Policy infrastructure and test-local Policy objects only, not a production Policy or other generated business artifact.
- No blockers or follow-ups remain.
