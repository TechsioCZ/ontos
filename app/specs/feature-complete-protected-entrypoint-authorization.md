---
type: feature
status: in_progress
created: 2026-09-02
---

# Feature: Complete protected-entrypoint authorization coverage

## Feature Description

Complete the fail-closed authorization rollout requested by GitHub issue #173 across every protected OntOS entrypoint, not only Actions. The feature adds one generated, machine-checked inventory of protected Actions, HTTP routes, Outbox workers, and capability-issuance paths; requires an explicit authorization classification for every entrypoint; provides a bounded report-only compatibility period; proves that required policy and deployment data exist before enforcement; and rejects missing policy, cross-tenant use, expired capabilities, replayed capabilities, and wrong audiences.

This plan complements PR #315. PR #315 supplies the Action permission relation, Action catalog, fail-closed Action runtime behavior, and fixed current-Action provisioning seam that this work should build on. It does not by itself satisfy the cross-surface inventory, explicit-classification, compatibility-reporting, migration-gate, capability-replay, or production-promotion requirements in issue #173.

## User Story

As an OntOS security and deployment operator
I want every protected entrypoint to declare and prove its authorization policy before production enforcement
So that missing configuration cannot silently grant access and the fail-closed migration can be measured, reviewed, and promoted without breaking legitimate traffic

## Problem Statement

OntOS currently has several independent protection mechanisms: Action execution permissions, governed route and read permissions, active-module checks, owner-local Outbox worker execution, and Shell-issued gateway capabilities. The repository has a module-entrypoint boundary checker, but it does not produce the complete authorization inventory required by issue #173 and its descriptors do not carry a closed authorization classification. PR #315 inventories and provisions current Actions only, grants every discovered Action to `tenant#member`, and immediately translates an unconfigured Action permission to a denial. It does not report the impact of the future denial before enforcement or prove readiness for routes, workers, and capability issuers.

Gateway capabilities also contain a `jti`, but the receiving MicroVertical only verifies signature and claims; it does not atomically consume the identifier. A still-valid assertion can therefore be replayed. The current tests cover wrong audience but do not provide the full negative matrix required by issue #173.

ADR-0019 accepts explicit fail-closed Action authorization, but it does not decide the wider protected-entrypoint classification and rollout contract in this specification. Issue #173 owns that technical implementation and readiness work. Production promotion is a separate human gate in issue #369, and the repository has no approved source-controlled production authorization context. Issue #169 is broader review context, not approval. Production enforcement must remain blocked until the technical and production gates are satisfied.

## Solution Statement

Extend the existing `ModuleEntrypointDescriptor` and its Effect schema with a required, closed authorization descriptor. Every entrypoint, including intentionally public entrypoints, must choose exactly one classification so omission cannot be confused with public access. Protected classifications must cover authenticated-principal access, context permission checks, Action execution permission, owner-local background work, and capability issuance. Action execution classifications must separately state whether tenant membership is the intended default grant or whether relationships must be provisioned explicitly; the latter must never receive a blanket tenant-member grant.

Use the existing repository-wide module-entrypoint boundary pass as the single derivation seam. Extend it to reconcile generated route metadata, Action catalogs, module manifests, registered Outbox workers, Shell HTTP contracts, and topology-owned capability issuers, then emit a deterministic, versioned inventory artifact as well as failing on omissions, duplicates, invalid classifications, or runtime entrypoints without descriptors. Do not introduce a second hand-maintained inventory.

Add a source-controlled authorization rollout contract with `report_only` and `enforced` modes, an expiry, the baseline inventory hash, and the approving issue/ADR. In report-only mode, the runtime always computes the future fail-closed decision. Only explicitly baselined, pre-existing compatibility behavior may retain its legacy result while emitting sanitized `authorization.would_deny` evidence; invalid, expired, wrong-audience, cross-tenant, and replayed credentials remain denied. New entrypoints are never eligible for compatibility behavior. An offline reducer turns exported evidence into a deterministic impact report grouped by surface, entrypoint, and denial reason without tokens or principal/tenant identifiers.

Add a readiness command that compares the classified inventory with the fixed deployment context and verifies required SpiceDB relationships, module state, worker ownership, issuer configuration, single-use capability storage, and the completed observation report. Production promotion is rejected unless the evidence is current for the same source revision and inventory hash, every required policy/data migration is complete, the compatibility period has been approved, and the negative smoke suite passes.

Implement capability replay rejection at the receiving deployment boundary so independently deployable MicroVerticals do not acquire a synchronous dependency on the Shell. Extend the `microvertical-action-boundary` Codesmith generator first, then regenerate/apply its output to Contacts. The generated verifier must atomically consume `(issuer, audience, jti)` in owner-local durable storage after cryptographic/claim validation and before private reads or Action resolution. Duplicate consumption is a typed unusable-credential response, concurrent redemption permits exactly one request, storage failure is fail-closed, and expired redemption rows are safely pruned.

## Relevant Files

Use these files to implement the feature:

- `../docs/adr/0019-explicit-action-authorization.md` — accepted Action authorization decision; it does not by itself accept the wider cross-surface contract or production promotion.
- `../docs/contexts/ontos/CONTEXT.md` — product and security semantics relevant to the protected-entrypoint work; current technical and production decisions remain in issues #173 and #369.
- `package.json` — exposes the inventory, impact-report, readiness, focused-test, and final quality-gate commands.
- `packages/core-runtime/src/modules/module-entrypoint.ts` — owns the Effect schema and descriptor shared by generated entrypoints.
- `packages/core-runtime/src/modules/module-entrypoint-gateway.ts` — enforces module-entrypoint state separately from the new authorization classification.
- `packages/core-runtime/src/actions/definition.ts` — Action entrypoint metadata and identity contract.
- `packages/core-runtime/src/modules/actions/catalog.ts` — PR #315's authoritative current core Action catalog and one inventory input.
- `packages/core-runtime/src/permissions/service.ts` — PR #315's Action permission decision seam and report-only/enforced decision integration point.
- `packages/core-runtime/src/permissions/context-access.ts` — existing fail-closed context-permission behavior used by protected reads and routes.
- `packages/core-runtime/src/install/action-authorization-provisioning.ts` — PR #315's fixed Action policy/data provisioning logic, which must honor explicit default-versus-narrow Action classifications.
- `packages/core-runtime/src/outbox/definition.ts` — Outbox worker descriptor and owner-local worker protection contract.
- `packages/shared-contracts/src/gateway-context.ts` — capability claim contract, including issuer, audience, expiry, tenant context, and `jti`.
- `apps/shell-super-app/shared/api.ts` — declares the session and API-key capability-issuance HTTP paths that must appear in the inventory.
- `apps/shell-super-app/api/index.ts` — mounts Shell HTTP handlers and must remain reconciled with classified route contracts.
- `apps/shell-super-app/api/auth/gateway-issuer.ts` — issues the short-lived gateway assertion and must supply the single-use identity expected by receivers.
- `apps/shell-super-app/api/auth/gateway-issuer-config.ts` — resolves issuer/audience configuration that the readiness gate must verify.
- `apps/shell-super-app/src/routes/ultramodern-route-metadata.ts` — generated route inventory input; public discovery metadata must remain distinct from authorization classification.
- `apps/shell-super-app/tests/unit/gateway-issuer.test.ts` — proves capability issuance claims and configuration failures.
- `verticals/contacts/api/auth/action-principal.ts` — PR #315's receiving capability verifier and the integration point for generated replay consumption.
- `verticals/contacts/src/api/action-gateway.ts` — mints one fresh assertion per invocation attempt and maps typed gateway failures.
- `verticals/contacts/src/routes/ultramodern-route-metadata.ts` — generated Contacts route inventory input.
- `verticals/contacts/src/db/schema.ts` — owner-local durable replay-redemption table.
- `verticals/contacts/drizzle/` — generated migration and metadata for the replay-redemption table.
- `verticals/contacts/tests/unit/action-principal.test.ts` — focused claim, expiry, audience, replay, concurrency, and storage-failure tests.
- `scripts/check-module-entrypoint-boundaries.mts` — existing single repository-wide inventory pass to extend with authorization reconciliation and deterministic output.
- `scripts/tests/module-entrypoint-boundaries.test.mts` — boundary-check regression coverage for missing, duplicate, invalid, and stale classifications.
- `scripts/provision-current-action-authorization.mts` — PR #315's fixed environment/topology provisioning entrypoint.
- `scripts/tests/provision-current-action-authorization.test.mts` — verifies default and explicit Action policy migration behavior and production rejection.
- `scripts/plan-deployment-impact.mts` — orders authorization schema/data expansion before consumers and will consume authorization readiness evidence.
- `scripts/tests/plan-deployment-impact.test.mts` — proves that an unsatisfied authorization gate stops promotion.
- `scripts/validate-ultramodern-workspace.mts` — repository contract gate that must include the new classification and artifact checks.
- `scripts/scaffolding/action/scaffold.mts` — generated Action descriptors must require an explicit Action authorization/provisioning classification.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — generated page metadata must include an explicit public or protected classification.
- `scripts/scaffolding/outbox-worker/scaffold.mts` — generated worker descriptors must include the owner-local background-work classification.
- `scripts/scaffolding/module-api/scaffold.mts` — generated module HTTP APIs must declare their protection model.
- `scripts/scaffolding/governed-contribution/scaffold.mts` — generated governed routes/reads must retain their context-permission target and declare it in inventory metadata.
- `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` — must generate replay-safe receiving boundaries before Contacts adopts the new generated artifact.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — generator snapshots and failure/atomicity checks for mandatory classification and replay support.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` — module contract generator coverage for manifest and entrypoint classifications.
- `topology/deployment-topology.generated.json` — fixed deployment ownership/audience input; it must not be used as a substitute for the missing approved production context.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — documents classification vocabulary, inventory derivation, and public-versus-protected semantics.
- `docs/architecture/ACTIONS.md` — documents Action default and explicit policy classes plus compatibility behavior.
- `docs/architecture/OUTBOX_WORKERS.md` — documents worker identity, active-module gating, and inventory requirements.
- `docs/architecture/ERRORS.md` — documents typed replay and authorization-readiness failures.
- `docs/architecture/DEPLOYMENT.md` — documents the report-only observation period, readiness evidence, and production enforcement gate.

### New Files

- `packages/core-runtime/src/authorization/entrypoint-classification.ts` — closed Effect schemas and types for explicit public/protected policy classification and rollout decisions.
- `packages/core-runtime/src/auth/gateway-assertion-redemption.ts` — narrow owner-provided interface and typed errors for atomic, single-use gateway assertions without coupling a MicroVertical to Shell storage.
- `scripts/authorization/protected-entrypoint-inventory.mts` — pure inventory derivation, normalization, hashing, and JSON serialization shared by checks and reports.
- `scripts/authorization/rollout-contract.mts` — source-controlled rollout schema and validation for mode, expiry, inventory hash, observation window, and decision reference.
- `scripts/report-fail-closed-authorization-impact.mts` — reduces sanitized report-only evidence into a deterministic impact report.
- `scripts/check-authorization-readiness.mts` — validates policy/data/evidence readiness for a fixed deployment context and emits machine-readable promotion evidence.
- `scripts/tests/protected-entrypoint-inventory.test.mts` — inventory derivation and deterministic-artifact tests.
- `scripts/tests/report-fail-closed-authorization-impact.test.mts` — impact reducer tests, including privacy and mixed-revision rejection.
- `scripts/tests/check-authorization-readiness.test.mts` — readiness and production-gate regression tests.
- `verticals/contacts/api/auth/gateway-assertion-redemption.ts` — generated Contacts adapter that atomically consumes assertion identifiers in owner-local storage.

## Implementation Plan

### Phase 1: Foundation

Align the accepted Action decision with the still-open cross-surface and production gates, define a closed classification and rollout contract, and extend Codesmith before creating or changing generated entrypoint artifacts. Reuse the existing module-entrypoint boundary checker as the single inventory source and make omissions fail the repository contract gate.

### Phase 2: Core Implementation

Generate deterministic inventory and report-only evidence, make Action provisioning classification-aware, add fixed-context readiness checks, and implement owner-local single-use capability redemption. Add focused unit, generator, script, database, and integration tests alongside each behavior.

### Phase 3: Integration

Wire readiness evidence into deployment planning and production promotion, run the complete negative authorization matrix across the actual Shell-to-MicroVertical boundary, update architecture/operator documentation, and execute all repository validation commands.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Align decision scope and rollout ownership

- [x] Treat ADR-0019 as accepted for Action authorization only; do not represent it as acceptance of the wider protected-entrypoint contract or production rollout.
- [ ] Resolve remaining technical architecture and readiness decisions in issue #173 and record production context and rollout-window approval in issue #369. Issue #169 remains broader review context, not an approval gate.
- [ ] Extend ADR-0019 or add a separate ADR before claiming the cross-surface classification, compatibility, replay, and evidence model as accepted durable architecture. Production promotion remains separately gated by issue #369.

### 2. Define explicit entrypoint authorization classifications

- [x] Add Effect schemas in `packages/core-runtime/src/authorization/entrypoint-classification.ts` and require them from `packages/core-runtime/src/modules/module-entrypoint.ts`; model intentional public access separately from protected policies for authenticated principals, context permissions, Action execution, owner-local background work, and capability issuance, with no `unknown` or implicit default.
- [x] Add Action provisioning intent (`tenant_membership_default` or `explicit`) to the Action-execution classification and validate that provisioning intent is illegal for other policy classes.
- [x] Add unit tests beside module, Action, and Outbox descriptor tests proving every valid variant, rejecting omissions/extra fields/incompatible combinations, and preserving the separation between route discovery metadata (`public`, `indexable`) and access authorization.

### 3. Extend Codesmith before updating generated artifacts

- [x] Update `scripts/scaffolding/action/scaffold.mts`, `microvertical-page/scaffold.mts`, `outbox-worker/scaffold.mts`, `module-api/scaffold.mts`, and `governed-contribution/scaffold.mts` so generation requires an explicit classification, writes it into the owning descriptor/route metadata, and aborts atomically on missing or invalid input.
- [x] Update `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` to generate the narrow assertion-redemption adapter and replay-safe verifier integration before creating the corresponding Contacts artifact.
- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` and `module-contract-generator.test.mts` with successful snapshots, omission failures, invalid-combination failures, repeat-run behavior, and atomic no-partial-output assertions.

### 4. Generate and machine-check the complete inventory

- [x] Extract pure discovery and normalization logic into `scripts/authorization/protected-entrypoint-inventory.mts`, then make `scripts/check-module-entrypoint-boundaries.mts` reconcile all Action catalogs, generated route metadata and mounted HTTP contracts, registered Outbox workers, module manifests, and topology-owned capability issuers.
- [x] Require every discovered entrypoint to have exactly one explicit classification and every classified entrypoint to resolve to exactly one runtime surface; fail on missing, orphaned, duplicate, ambiguous, stale, or hand-authored generated metadata.
- [x] Emit `.codex/reports/authorization/protected-entrypoints.json` deterministically with a schema version, source revision, inventory hash, surface, stable entrypoint key, owner/deployment, classification, and policy/provisioning intent; exclude secrets, tokens, and tenant/principal identifiers.
- [x] Add `scripts/tests/protected-entrypoint-inventory.test.mts` and extend `scripts/tests/module-entrypoint-boundaries.test.mts` with complete fixtures for Actions, protected and public routes, workers, both capability issuers, and each reconciliation failure.
- [x] Add `authorization:inventory:check` to `package.json` and include it in `contract:check`/`check` without adding a parallel hand-maintained registry.

### 5. Add bounded report-only compatibility evidence

- [x] Define and validate a source-controlled rollout contract in `scripts/authorization/rollout-contract.mts` with `report_only`/`enforced` mode, decision reference, activation and expiry, baseline source revision, inventory hash, and the explicit set of pre-existing compatibility-eligible entrypoints; missing, malformed, stale, or expired configuration must fail closed.
- [ ] At the existing Action, context-permission, worker, and capability-issuance decision seams, compute both the current result and the candidate fail-closed result. Preserve legacy allow behavior only for baselined entrypoints and only for a missing-policy candidate denial in active report-only mode; never bypass malformed credentials, expiry, wrong audience, replay, cross-tenant scope, disabled modules, or infrastructure failures.
- [x] Emit one sanitized `authorization.would_deny` event with schema version, source revision, inventory hash, surface, stable entrypoint key, policy class, reason, and timestamp. Do not emit assertion contents, API keys, principal identifiers, tenant identifiers, resource identifiers, or relation tuples.
- [x] Implement `scripts/report-fail-closed-authorization-impact.mts` to reject mixed/stale schemas, revisions, or inventory hashes and emit `.codex/reports/authorization/fail-closed-impact.json` with observation bounds and aggregate counts by surface, entrypoint, policy class, and denial reason.
- [x] Add focused runtime tests for report-only preservation, enforced denial, non-eligible new entrypoints, expired rollout configuration, non-bypassable denials, single-event emission, redaction, and deterministic aggregation; add reducer fixtures to `scripts/tests/report-fail-closed-authorization-impact.test.mts`.

### 6. Migrate and prove policy/data readiness

- [x] Change `packages/core-runtime/src/install/action-authorization-provisioning.ts` and `scripts/provision-current-action-authorization.mts` so only Actions classified as `tenant_membership_default` receive the fixed tenant-member grant; `explicit` Actions must have their intended relationships verified and must never receive a blanket grant.
- [x] Implement `scripts/check-authorization-readiness.mts` to load only an approved fixed environment/topology context and verify inventory completeness, SpiceDB schema and required relationships, governed-route permission targets, active-module data and worker ownership, issuer/audience configuration, assertion-redemption storage migration, compatibility observation bounds, approval reference, and a zero-unresolved-impact decision.
- [x] Emit deterministic `.codex/reports/authorization/readiness.json` bound to the deployment environment, source revision, inventory hash, schema/data versions, impact-report hash, and approval reference, without secrets or subject/resource identifiers.
- [x] Extend provisioning, readiness, and migration tests to prove idempotency, default-versus-explicit grants, missing relationships, stale evidence, mixed revisions, absent module state, incorrect issuer/audience topology, missing replay storage, unapproved observations, and fixed-context-only operation.

### 7. Reject replayed gateway capabilities at the owner boundary

- [x] Add the narrow redemption contract and typed replay/unavailable errors in `packages/core-runtime/src/auth/gateway-assertion-redemption.ts`; the contract must consume `(issuer, audience, jti)` atomically with the assertion expiry and expose no Shell persistence implementation to MicroVertical code.
- [x] Add the owner-local redemption table to `verticals/contacts/src/db/schema.ts`, generate its Drizzle migration under `verticals/contacts/drizzle/`, and use a unique key that makes concurrent redemption of the same assertion succeed exactly once; retain only the minimum assertion identity and expiry needed for replay protection and define expiry-plus-clock-skew cleanup.
- [x] Apply the updated `microvertical-action-boundary` generator output to `verticals/contacts/api/auth/gateway-assertion-redemption.ts` and `action-principal.ts`. Verify signature, issuer, audience, expiry, and required claims before consumption; consume before private reads or Action resolution; map duplicates to the typed unusable-credential response and storage failures to a typed fail-closed unavailable response.
- [x] Extend Contacts schema/migration tests and `verticals/contacts/tests/unit/action-principal.test.ts` for first use, sequential replay, concurrent replay, wrong audience, explicit expiry, malformed or missing `jti`, unavailable storage, and cleanup. Prove invalid/expired/wrong-audience assertions do not write redemption state and a retry carrying a newly issued assertion remains valid.

### 8. Gate deployment and production enforcement

- [x] Extend `scripts/plan-deployment-impact.mts` so authorization schema/data expansion and replay-store migration precede all affected consumers and `enforced` promotion requires matching inventory, impact, readiness, and negative-smoke evidence from the exact build artifact.
- [x] Keep production provisioning/promotion rejected until an approved, source-controlled production deployment context exists. Once approved, add that fixed context without arbitrary tenant/Action CLI inputs and require the same checks used in stage.
- [x] Add deployment-plan tests proving that one missing/stale/mismatched gate blocks promotion, report-only may run only until its declared expiry, no new entrypoint can join the compatibility baseline implicitly, and production cannot run with absent or report-only configuration after the enforcement gate.

### 9. Exercise the complete negative authorization matrix

- [x] Add cross-boundary integration fixtures that issue real short-lived assertions through the Shell issuer and call the Contacts receiver with a matching source revision/configuration.
- [ ] Prove missing Action policy denies after enforcement, a principal from the wrong tenant cannot use another tenant's context, an expired capability is rejected, a consumed capability cannot be replayed, concurrent replay admits one request only, and a capability for the wrong audience is rejected.
- [ ] Cover both session-backed and API-key-backed issuance paths and assert stable HTTP/Effect error mapping, `WWW-Authenticate: Bearer` where applicable, no private-domain reads before credential/redemption success, and no sensitive values in logs or reports.

### 10. Document the protected-entrypoint contract and operator runbook

- [ ] Update `docs/architecture/MODULE_ENTRYPOINTS.md`, `ACTIONS.md`, `OUTBOX_WORKERS.md`, `ERRORS.md`, and `DEPLOYMENT.md` with the implemented classification table, inventory ownership, generator workflow, report-only restrictions, evidence schemas, replay semantics, policy/data migration order, rollback behavior, and production promotion/abort procedure. Distinguish accepted Action scope, open cross-surface decisions, and production approval.
- [x] Update `README.md` with the supported inventory, impact, readiness, and focused validation commands and identify generated `.codex/reports/authorization/` artifacts as non-secret operator evidence.
- [x] Cross-link technical issue #173, production gate #369, broader review #169, PR #315, and accepted ADR-0019 without implying that the wider cross-surface contract or production enforcement is approved.

### 11. Run all validation commands

- [ ] Execute every command in `Validation Commands` in order, retain the generated inventory evidence needed for review, and resolve every implementation failure without weakening a contract or skipping a required negative case. All non-build commands pass, but the literal `mise exec -- pnpm build` command rejects the dirty review worktree's non-promotable `workspace` source revision; the build passes when `ULTRAMODERN_SOURCE_REVISION` is set to the reviewed HEAD. Impact/readiness promotion evidence is intentionally not fabricated while issue #173 remains incomplete and issue #369 plus the production context remain unapproved.

## Testing Strategy

### Unit Tests

Use Effect-schema and pure-script fixtures to prove closed classification decoding, inventory determinism, reconciliation errors, rollout expiry/baseline rules, sanitized impact aggregation, readiness evidence matching, and classification-aware Action provisioning. Use generated verifier tests to prove validation order, single-use redemption, exactly-one concurrent success, typed replay/unavailable errors, and no writes for invalid assertions. Extend generator tests so all newly generated entrypoints are classified and replay support is created atomically.

### Integration Tests

Exercise the actual Shell issuer, shared gateway contract, Contacts receiver, owner-local redemption database, Action permission service, and SpiceDB-backed Action runtime. Run the full negative matrix for both session and API-key issuance and verify that deployment planning accepts only evidence produced for the exact build, inventory, and fixed deployment context. Retain existing route, module-state, Action, and Outbox integration suites to prove the new metadata does not merge or bypass their independent gates.

### Edge Cases

- A public route is explicitly classified public but is accidentally marked protected, or a discovery `public` flag is mistaken for authorization.
- A protected route is mounted but absent from generated metadata, or metadata names a route that is no longer mounted.
- An Action is classified `explicit` but the fixed provisioner attempts a tenant-member grant.
- A worker has an active descriptor but no owning deployment or no active tenant-module state.
- A capability-issuance path exists for session credentials but not API-key credentials, or their audiences differ from topology.
- Report-only configuration is missing, expired, stale, or references an inventory other than the running build.
- A new entrypoint appears after the compatibility baseline and attempts to inherit legacy allow behavior.
- Evidence contains mixed schema versions, source revisions, inventory hashes, time windows, or sensitive identifiers.
- The same valid assertion is submitted sequentially or concurrently to one or multiple instances.
- Assertion redemption storage is unavailable, the `jti` is absent/malformed, or cleanup races with a still-valid assertion.
- A credential is expired, for the wrong audience, signed by the wrong issuer, scoped to the wrong tenant, or used after its tenant module is disabled.
- Readiness succeeds in stage but no approved production context exists; production must remain blocked.

## Acceptance Criteria

- [x] A generated, deterministic, machine-checked inventory covers every protected Action, HTTP route, Outbox worker, and capability-issuance path, with no second hand-maintained registry.
- [x] Every entrypoint explicitly declares intentional public access or exactly one protected authorization classification; missing, invalid, duplicate, orphaned, and stale classifications fail generation or repository checks.
- [x] New protected entrypoints are enforced immediately and cannot inherit the compatibility baseline.
- [ ] A bounded report-only period measures candidate fail-closed denials while preserving only explicitly approved legacy missing-policy behavior and never bypassing invalid credentials, expiry, wrong audience, replay, cross-tenant access, disabled modules, or infrastructure failures.
- [x] The impact report is deterministic, bound to one source revision/inventory hash/observation window, and contains no token, secret, tenant, principal, resource, or relation-tuple values.
- [x] Action provisioning grants tenant members only for explicitly default-classified Actions; narrow/explicit Actions require intended policy data and never receive blanket membership grants.
- [ ] Readiness evidence proves policy/data migration, route and worker protection data, issuer/audience configuration, replay storage, observation approval, and negative-smoke results for the exact deployment artifact and fixed context.
- [x] Production remains blocked until an approved source-controlled production context and matching current evidence exist; once the gate is satisfied, missing policy denies in production and report-only configuration is rejected.
- [x] Gateway assertions are single use at the receiving owner boundary: sequential and concurrent replay are rejected, exactly one concurrent redemption succeeds, and storage failure fails closed without creating a Shell runtime dependency.
- [ ] Automated negative tests cover missing policy, wrong tenant, expired capability, replay, and wrong audience across both session and API-key issuance paths.
- [ ] Architecture and deployment documentation describes the accepted classification, compatibility, evidence, migration, replay, promotion, abort, and rollback contracts.
- [ ] Issue #173 records completion of the technical criteria, and issue #369 records Petr/Jiří production approval before enforcement. Issue #169 remains broader review context, not an approval gate.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm test:generation` — validate all updated Codesmith generators, mandatory classifications, atomicity, and repeat-run behavior.
- `mise exec -- pnpm authorization:inventory:check` — derive and reconcile the complete protected-entrypoint inventory and write its deterministic evidence artifact.
- `mise exec -- pnpm test:scripts` — run inventory, impact-report, readiness, provisioning, migration, and deployment-script regressions.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — validate Action classification, permission, policy, runtime, and report-only decisions.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — validate SpiceDB-backed Action policy behavior and missing-policy enforcement.
- `mise exec -- pnpm --filter @app/core-runtime outbox:test:unit` — validate worker descriptors and owner-local background authorization metadata.
- `mise exec -- pnpm --filter @app/core-runtime outbox:test:integration` — validate worker runtime behavior remains gated independently.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate both capability issuers, route classifications, and configuration failures.
- `mise exec -- pnpm --filter @app/contacts test:unit` — validate Contacts capability verification, replay redemption, schema, and generated boundary behavior.
- `mise exec -- pnpm --filter @app/contacts test:integration` — validate Shell-to-Contacts capability and Action authorization negative cases with owner-local persistence.
- `mise exec -- pnpm test:deployment-impact` — validate migration ordering and evidence-gated promotion.
- `mise exec -- pnpm module-entrypoints:check` — validate module-entrypoint ownership and classification reconciliation.
- `mise exec -- pnpm contract:check` — validate repository boundaries, generated contracts, and authorization artifact checks.
- `mise exec -- pnpm build` — validate deployable public surfaces and generated route/module artifacts.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Implementation depends on PR #315 being merged or its exact Action authorization changes being present. This plan intentionally does not duplicate that PR's Action permission model, current Action catalog, or fail-closed Action runtime work.
- ADR-0019 is accepted for Action authorization. This plan's wider cross-surface classification, replay, readiness, and evidence contract remains owned by issue #173; do not present it as accepted durable architecture without a corresponding ADR or explicit decision.
- Production enforcement remains blocked until issue #369 records approval and OntOS has an approved source-controlled production deployment context. The development/stage-only provisioning contract must continue to reject production rather than accepting arbitrary tenant or Action inputs.
- The recommended replay design is owner-local durable redemption because it preserves MicroVertical deployment independence. If the accepted ADR assigns redemption ownership elsewhere, revise this plan before implementation instead of adding a synchronous private Shell dependency.
- `.codex/reports/authorization/` is an operator-evidence output location, not a source of runtime policy. Runtime configuration and approval references remain source controlled; reports must be reproducible and safe to retain in CI artifacts.
- The classification literals already present in schemas and inventory are the current implemented technical contract under issue #173; they do not prove the remaining readiness criteria or production approval. Any semantic change must update the owning ADR or decision, this plan, implementation guidance, schemas, and tests together.
- No user-facing UI work is included; the scope is runtime authorization, generators, storage, deployment evidence, tests, and operator documentation.

### Implementation evidence and explicit deviation (2026-09-02)

- The user explicitly directed implementation to proceed while wider governance remained open. This scoped override did not expand ADR-0019 beyond Actions, accept the cross-surface contract as durable architecture, authorize production, or satisfy issue #369.
- Production provisioning and readiness remain blocked. No impact or readiness promotion artifact was fabricated from an unobserved window or an unapproved decision.
- The deterministic inventory contains 51 entries (16 Actions, 33 route/read surfaces, and both capability issuers), is bound to source revision `e402b254ce9c08699f4e8ccea42b74f24d11f1db`, and has inventory hash `b529d6b394d276982917765cc8413a9d9da404ad63063fcdce4c0cf0b8f63e9c`.
- The report-only contract is bounded from 2026-09-02 through 2026-09-30 and has an empty compatibility baseline, so no existing or new entrypoint receives a legacy authorization bypass.
- The owner-local replay migration was generated with the repository command and applied to the sandbox database. The normal Contacts boundary generator command was attempted first, but unrelated stale generated topology referenced a missing `verticals/crm/package.json`; the generator was updated and its Contacts-owned output was applied directly without editing that unrelated topology.
- Every command in `Validation Commands` was executed in order. After repairing surfaced fixtures and boundary violations: generator coverage passed (47 tests), repository script coverage passed (92 tests), Action unit/integration passed (64/19), Outbox unit/integration passed (19/8), Shell unit passed (173), Contacts unit/integration passed (59/11), deployment impact passed (30), inventory/module/contract checks passed, the build passed with `ULTRAMODERN_SOURCE_REVISION=e402b254ce9c08699f4e8ccea42b74f24d11f1db`, and `pnpm check` passed end to end. The literal build command remains unsatisfied because the release-envelope gate correctly rejects the dirty worktree's `workspace` source revision.

### Implementation review correction (2026-09-02)

- The rollout decision now preserves every denial from the current authorization path; a candidate allow can never broaden current access.
- `baselineSourceRevision` is treated as the historical observation baseline rather than requiring it to equal the commit that contains the contract. Current inventory, impact, smoke, and readiness evidence still bind enforced promotion to the exact build revision.
- The stage deployment workflow now derives the exact-build inventory and invokes the stage authorization promotion gate automatically.
- Route-manifest reconciliation is exact per deployment and rejects missing, orphaned, cross-owner, and duplicate generated entries. Impact evidence fields now use closed values and safe identifier formats so sensitive values cannot be smuggled through allowed keys.
- The prior checkmarks overstated runtime coverage. Only the Action permission seam calls the report-only decision today, and the cross-boundary fixture signs preconstructed session/API-key principal contexts instead of exercising the actual Shell session and raw API-key HTTP issuance handlers through the full Contacts Action path. Those tasks and acceptance criteria are reopened above.
