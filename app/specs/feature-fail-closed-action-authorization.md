---
type: feature
status: complete
created: 2026-09-02
---

# Feature: Fail-closed Action authorization with explicit environment grants

## Feature Description

Make every OntOS Action require an explicit SpiceDB executor relationship. An Action with no
executor relationship must be rejected before its handler runs, and a user-triggered Contacts Action
denial must appear as a localized `@techsio/ui-kit` error Toast.

Preserve development convenience through explicit environment data rather than a code bypass. One
operator-invoked, idempotent provisioning command must expand the compatible SpiceDB schema and
grant every current Action to the membership set of the fixed development Tenant. The same command
must support the fixed stage Tenants later, without accepting arbitrary Tenant or Action input and
without running during application startup, sandbox preparation, database migration, or deployment.

The rollout has two mandatory checkpoints in one Locki sandbox: first prove that an Action without
a relationship is denied and displays the Toast; then run the provisioning command and prove that
the same authenticated Tenant member can execute the Action. Stage provisioning is a later
operator-controlled promotion gate and must happen before the fail-closed runtime is deployed to
stage.

## User Story

As an authenticated OntOS user
I want every Action to have an explicit authorization rule and receive clear feedback when it does not
So that missing authorization configuration cannot silently permit a state change

## Problem Statement

`packages/core-runtime/src/permissions/service.ts` currently performs an `action#is_restricted`
self-check before checking `action#execute`. When the restriction marker is absent it returns the
`unconfigured` decision, and `packages/core-runtime/src/actions/runtime.ts` rejects only `denied`.
Therefore an Action with no SpiceDB relationships is allowed to reach its Policy and handler
boundaries. The current live integration test explicitly protects this compatibility behavior.

Existing Contacts BFFs already map `ActionPermissionDenied` to the declared `ContactsForbiddenProblem` 403,
and Contacts features already classify that public error as `forbidden`, but mutation feedback is inline
and no Contacts Toast renderer is mounted for both standalone and federated rendering. Existing local
and stage context bootstraps establish Tenant membership but do not grant the current Action set to
those membership sets. The SpiceDB schema also limits `action#executor` to a direct `principal`, so
it cannot yet express “every authenticated active member of this specific Tenant.”

## Solution Statement

Change the canonical permission decision to a single fully-consistent `action#execute` check:
`HAS_PERMISSION` is allowed, `NO_PERMISSION` is a definite denial, and conditional, malformed, or
unavailable results remain the existing retryable `ActionPermissionCheckError`. Remove
`unconfigured` from the decision vocabulary and let the existing Action runtime denial finalizer
produce `ActionPermissionDenied`, one terminal `action.rejected` audit record, and no handler or
business writes.

Compatibly expand `action#executor` to accept `principal | tenant#member`. Keep the legacy
`restriction` relation during this rollout so old application versions and existing direct
Principal tuples remain schema-compatible, but stop consulting it in the new runtime. Add a
generated Core Action catalog and combine it with action descriptors from each topology-owned
public module deployment contract so the provisioning command covers all eight current Core Actions
and all eight current Contacts Actions without importing a MicroVertical's private runtime into another
deployment.

Create one parameterless `authorization:provision-current-actions` command. It must derive the
current Action set, select only the source-controlled development or stage Tenant set from the
validated deployment environment, apply the compatible SpiceDB schema, `TOUCH` each
`action:<encoded-key>#executor@tenant:<fixed-tenant>#member` relationship, and verify representative
allowed and denied checks. It must reject production, arbitrary identifiers, incompatible
endpoints, missing Tenant membership, and incomplete Action discovery. It is authorization
environment provisioning—not a PostgreSQL migration—and must be safe to rerun.

For Contacts, mount `Toaster` once in the standalone layout and once per loaded federated page root, then
use `useToast()` in the six existing mutation feature surfaces. On the closed `forbidden` Action
state, create an error Toast using the existing localized action-specific forbidden copy. Keep
validation, conflict, authentication, unavailable/retry, loading, empty, responsive, and
accessibility behavior unchanged; do not turn indeterminate 503 failures into permission denials.

## Relevant Files

Use these files to implement the feature:

- `../docs/adr/0019-explicit-action-authorization.md` — accepted decision establishing fail-closed authorization with an explicit Tenant-membership default rule.
- `packages/core-runtime/src/permissions/service.ts` — current restriction-marker classification and Action permission decision.
- `packages/core-runtime/src/actions/runtime.ts` — canonical Action authorization boundary and durable denial finalization.
- `packages/core-runtime/src/actions/errors.ts` — existing typed denial and indeterminate authorization failures.
- `packages/core-runtime/spicedb/bootstrap.yaml` — development SpiceDB schema, fixtures, and permission assertions.
- `packages/core-runtime/spicedb/stage-bootstrap.yaml` — empty-stage schema that must remain aligned with development without fixture relationships.
- `packages/core-runtime/src/modules/actions/*.action.ts` — the eight current Core Action registrations that the generated catalog must own.
- `packages/core-runtime/src/index.ts` — generated Core Action exports and public Core surface.
- `scripts/scaffolding/action/scaffold.mts` — Codesmith Action generator that must keep future Core Actions in the catalog automatically.
- `scripts/scaffolding/shared.mts` — generated-slot constants used by the Action generator.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — generator regression coverage for atomic catalog updates.
- `scripts/generate-ontos-module-contract.mts` — existing safe derivation of public MicroVertical Action descriptors.
- `scripts/initialize-local-development.mts` — fixed development Tenant/Principal context and membership data; provisioning must reuse but not join automatic initialization.
- `scripts/locki-feature.sh` — sandbox preparation contract that must continue to omit Action authorization provisioning for the first checkpoint.
- `scripts/tests/initialize-local-development.test.mts` — fixed local context and relationship tests.
- `packages/core-runtime/src/install/stage-context-bootstrap.ts` — fixed stage Tenant/Principal contexts and membership relationships.
- `apps/shell-super-app/api/auth/stage-demo-bootstrap-runtime-infrastructure.ts` — existing operator-invoked stage context boundary that must remain ordered before Action grants.
- `apps/shell-super-app/scripts/bootstrap-stage-demo.sh` — existing secret-safe operator workflow; it must not make Action provisioning an automatic startup effect.
- `package.json` — root operator command and focused validation scripts.
- `scripts/validate-ultramodern-workspace.mts` — repository contract proving provisioning remains explicit and is not wired into startup/deploy paths.
- `packages/core-runtime/tests/unit/action-permission.test.ts` — low-level request, decision, sanitization, and compatibility tests.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — Action lifecycle ordering and missing-rule denial tests.
- `packages/core-runtime/tests/integration/action-permission.test.ts` — live PostgreSQL/SpiceDB proof for missing, direct-Principal, Tenant-membership, other-Tenant, concurrent, and unavailable outcomes.
- `packages/core-runtime/tests/unit/spicedb-database-bootstrap.test.ts` — development/stage schema alignment contract.
- `docs/architecture/ACTIONS.md` — authoritative Action lifecycle and explicit authorization rule.
- `docs/architecture/ERRORS.md` — typed 403 versus retryable 503 contract.
- `docs/architecture/DEPLOYMENT.md` — ordered SpiceDB expansion, stage relationship provisioning, runtime deployment, verification, and rollback.
- `DEVELOPMENT.md` — the two-checkpoint Locki sandbox workflow.
- `verticals/contacts/api/index.ts` — existing exhaustive `ActionPermissionDenied` to `ContactsForbiddenProblem` 403 mapping that must remain intact.
- `verticals/contacts/shared/api.ts` — declared typed 403 Problem Details contract consumed by the generated client.
- `verticals/contacts/src/routes/layout.tsx` — standalone Contacts Toast portal location.
- `verticals/contacts/src/federation/page-*.tsx` — federated Contacts page roots that need one Toast portal when Shell renders the remote without the standalone layout.
- `verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx` — archive/unarchive Customer mutation feedback.
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/page.tsx` — archive/unarchive Contact mutation feedback.
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/new/page.tsx` — create Customer mutation feedback.
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/edit/page.tsx` — edit Customer mutation feedback.
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/contacts/new/page.tsx` — create Contact mutation feedback.
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/edit/page.tsx` — edit Contact mutation feedback.
- `verticals/contacts/locales/en/contacts.json` and `verticals/contacts/locales/cs/contacts.json` — existing localized forbidden copy to reuse for Toasts; change only if a short Toast title cannot reuse current copy.
- `verticals/contacts/tests/components/*-page.test.tsx` — component proofs for all six mutation surfaces, standalone/federated Toast rendering, and unchanged closed error mappings.
- `verticals/contacts/tests/integration/customer-contact-bff.test.ts` — typed 403 serialization and generated-client decoding proof.

### New Files

- `packages/core-runtime/src/modules/actions/catalog.ts` — generated-slot-owned catalog of current and future Core Action registrations for safe authorization discovery.
- `packages/core-runtime/src/permissions/schema.ts` — canonical OntOS SpiceDB schema string used by operator schema writes and checked against both bootstrap YAML files.
- `packages/core-runtime/src/install/action-authorization-provisioning.ts` — reusable Effect boundary for compatible schema publication, fixed Tenant-membership executor relationships, verification, and sanitized failures.
- `scripts/provision-current-action-authorization.mts` — parameterless development/stage operator entrypoint behind the root package command.
- `scripts/tests/provision-current-action-authorization.test.mts` — Action discovery, fixed-environment selection, tuple construction, idempotence, and safety-guard tests.

## Implementation Plan

### Phase 1: Foundation

Accept the proposed authorization decision, create one authoritative Core Action catalog maintained
by Codesmith, derive MicroVertical Actions from public deployment contracts, and define a canonical
compatible SpiceDB schema whose executor relation accepts a direct Principal or one fixed Tenant's
member set. Protect the current 16-Action baseline and prevent automatic provisioning.

### Phase 2: Core Implementation

Remove the `unconfigured` allow path, reuse the existing durable Action denial finalizer, and add the
explicit environment-gated provisioning command. Prove fail-closed, direct-grant compatibility,
Tenant membership grants, cross-Tenant denial, indeterminate failures, idempotence, and complete
current Action coverage with unit and live integration tests.

### Phase 3: Integration

Render the UI-kit Toast portal in standalone and federated Contacts surfaces, map only definite Action
forbidden states to localized error Toasts, execute the two human sandbox checkpoints in order, and
document the later stage expand/provision/verify/deploy sequence. The sandbox must never mutate
stage.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Accept the fail-closed architecture prerequisite

- [x] Have the maintainers change `../docs/adr/0019-explicit-action-authorization.md` from Proposed to Accepted (and commit its index entry) or record an equivalent explicit approval in issue #169 before changing runtime behavior; do not overwrite the current uncommitted ADR work.

### 2. Make the current Action set discoverable and generator-owned

- [x] Add `packages/core-runtime/src/modules/actions/catalog.ts` with generated import/value slots containing the eight current Core Action registrations; export only the safe catalog needed by repository tooling.
- [x] Extend `scripts/scaffolding/shared.mts` and `scripts/scaffolding/action/scaffold.mts` so `mise exec -- pnpm scaffold:action -- --scope core ...` atomically adds every future Core Action to its file, public export, and catalog in sorted order.
- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` for initial generation, sorted insertion, duplicate refusal, dry-run/atomicity, and preservation of developer-owned content.
- [x] In the provisioning tool, combine Core catalog descriptors with each topology-owned vertical's safe public deployment contract from `deriveOntosModuleDeploymentContract`; reject duplicate keys, invalid contracts, failed owner discovery, or an empty/incomplete set rather than provisioning a partial baseline.
- [x] Add a regression assertion that the present baseline contains exactly the eight `core.identity`/`core.modules` keys and eight `contacts.core` keys (16 unique Actions), while deriving future vertical Actions from their generated manifest/registration path instead of a second hand-written Contacts list.

### 3. Expand the SpiceDB schema compatibly

- [x] Add the canonical schema value in `packages/core-runtime/src/permissions/schema.ts` and update both bootstrap YAML schemas so `action#executor` accepts `principal | tenant#member` and `execute = executor`.
- [x] Retain `action#restriction` and `is_restricted` during this expand/deploy rollout for N/N-1 schema compatibility, but document that the candidate runtime no longer reads the marker; defer its removal to a later contract release after old code and tuples are gone.
- [x] Update `packages/core-runtime/tests/unit/spicedb-database-bootstrap.test.ts` and permission schema assertions so development/stage schemas exactly match the canonical value, stage still contains no fixture relationships, membership-set executor syntax is accepted, and existing direct-Principal executor tuples still work.

### 4. Deny every missing Action executor rule

- [x] Refactor `packages/core-runtime/src/permissions/service.ts` to issue one fully-consistent `execute` check, reduce `ActionPermissionDecision` to `allowed | denied`, classify `NO_PERMISSION` as `denied`, and preserve conditional, unspecified, malformed, timeout, credential, transport, and schema failures as sanitized `ActionPermissionCheckError` values.
- [x] Update `packages/core-runtime/src/actions/runtime.ts` so every definite negative decision uses the existing `rejectPermissionDenied` transaction before Policy/service/handler resolution; do not change 403/503 typing, invocation idempotency, denial audit shape, or additional Tenant-role checks.
- [x] Rewrite `packages/core-runtime/tests/unit/action-permission.test.ts` and `packages/core-runtime/tests/unit/action-runtime.test.ts` so a missing executor relation fails with `ActionPermissionDenied`, does not evaluate Policies or resolve services/handlers, and an indeterminate check remains retryable with an open `received` invocation.
- [x] Extend `packages/core-runtime/tests/integration/action-permission.test.ts` to prove: no relationship produces one terminal denial and no business write; `executor@tenant:<tenant>#member` permits the member Principal; a Principal from another Tenant and a non-member are denied; an existing direct Principal executor remains allowed; concurrent denials produce one audit event; and unavailable SpiceDB remains `ActionPermissionCheckError` without terminal denial evidence.
- [x] Retain the existing exhaustive Contacts and Shell BFF mappings so `ActionPermissionDenied` stays a declared 403 Problem Details response and `ActionPermissionCheckError` stays a declared retryable 503.

### 5. Add the explicit current-Action provisioning command

- [x] Implement `packages/core-runtime/src/install/action-authorization-provisioning.ts` as a typed Effect service that publishes the compatible schema, writes idempotent `TOUCH` updates for every derived Action and fixed Tenant membership set, then verifies every expected allowed relation and representative denied Principal without logging secrets.
- [x] Implement `scripts/provision-current-action-authorization.mts` and the root `authorization:provision-current-actions` package script with no Tenant, Principal, Action, endpoint, or environment CLI parameters. In `development`, accept only the existing loopback SpiceDB configuration and `LOCAL_DEVELOPMENT_CONTEXT`; in `stage`, accept only the existing stage-private SpiceDB configuration and both `STAGE_CONTEXTS`; reject production and every other environment.
- [x] Require the fixed Tenant/Principal membership checks to succeed before granting Actions. Build subjects as `tenant:<fixed-tenant>#member`, never a global Principal wildcard, and preserve authentication/active-Principal resolution as a separate prerequisite before the Action runtime.
- [x] Add `scripts/tests/provision-current-action-authorization.test.mts` for exact environment selection, current Action discovery, lossless `toSpiceDbActionObjectId` encoding, expected relationship counts (16 development grants and 32 stage grants for the present baseline), subject relation `member`, deterministic ordering, duplicate rejection, safe reruns, partial-discovery failure, and sanitized configuration/service errors.
- [x] Extend `scripts/validate-ultramodern-workspace.mts` to assert that neither `scripts/locki-feature.sh`, ordinary `local:initialize`, `zerops.yaml`, SpiceDB/application startup, nor automatic deployment invokes the provisioning command.

### 6. Show definite Action denials as Contacts Toasts

- [x] Import and mount `Toaster` in `verticals/contacts/src/routes/layout.tsx` for standalone Contacts and in each existing `verticals/contacts/src/federation/page-*.tsx` root for Shell-loaded remote pages; mount it at the page/application boundary, never inside a button, form, repeated row, or mutation callback.
- [x] In the six mutation route files listed under Relevant Files, call `useToast()` and create `{ type: 'error' }` Toast feedback only when the exhaustively classified Action result is `forbidden`. Use the existing localized action-specific forbidden text, avoid hardcoded UI copy or custom Toast styling, and prevent duplicate Toast creation for one mutation completion.
- [x] Keep invalid form messages inline, keep loading/pending controls disabled as today, keep conflict/authentication/unavailable outcomes in their current closed presentation and retry rules, and do not show an authorization Toast for loader/read 403s or indeterminate 503s.
- [x] Update the six matching Contacts component test suites to render the Toast portal, assert the localized English and Czech denial feedback is exposed accessibly, assert one Toast per rejected mutation, and assert no navigation, cache mutation, lifecycle change, or retry suggestion occurs. Preserve the existing tests for loading, empty, validation, conflict, authentication, unavailable/retry, responsive semantics, and exhaustive error classification.
- [x] Keep `verticals/contacts/tests/integration/customer-contact-bff.test.ts` proving that the internal typed denial is serialized as `ContactsForbiddenProblem` 403 and decoded by the generated Effect client before feature code maps it to Toast feedback.

### 7. Pause for the first sandbox denial checkpoint

- [x] In one isolated Locki feature sandbox containing the candidate code, do not run `authorization:provision-current-actions`. Start the app, sign in as `demo@test.com`, invoke a representative current Contacts Action, and let the developer verify the localized error Toast, 403 response, terminal rejected invocation/audit evidence, absence of a business write, and absence of an Action handler effect. Record the Action key and correlation/invocation evidence without secrets.
- [x] Do not continue to the provisioning checkpoint until the developer confirms the missing-rule denial behavior in that same sandbox.

### 8. Provision the same sandbox and pause for the allowed checkpoint

- [x] In the unchanged sandbox, run `mise exec -- pnpm authorization:provision-current-actions`; record that the command discovered all 16 current Actions, wrote 16 development Tenant-membership grants, and passed its allowed/denied verification. Run it a second time to prove idempotence.
- [x] Retry the same Contacts Action as `demo@test.com` and let the developer verify that it now succeeds through the normal Action lifecycle without a denial Toast. Also verify a Principal outside the fixed development Tenant does not inherit the grant.
- [x] Do not rebuild the sandbox, reset SpiceDB, change code to bypass authorization, or write any stage relationship as part of these two checkpoints.

### 9. Prepare and execute the later stage promotion gate

- [x] Update `docs/architecture/ACTIONS.md`, `docs/architecture/ERRORS.md`, `docs/architecture/DEPLOYMENT.md`, `DEVELOPMENT.md`, and the task-relevant README guidance to describe missing-rule denial, the explicit membership-set grant, the operator command, and the exact sandbox/stage ordering.
- [x] Document and rehearse stage as expand/provision/verify/deploy: first ensure the fixed stage contexts and Tenant membership exist; run the same `authorization:provision-current-actions` command from the candidate migration artifact to publish the compatible schema and add 32 fixed stage grants; verify every current Action for both fixed stage Principals plus a denied non-member; only then deploy the fail-closed runtime and run representative allowed and missing-rule-denied smoke checks.
- [x] Keep stage provisioning operator-invoked, stage-gated, idempotent, conflict/failure detecting, and separate from PostgreSQL migrations and startup. Record rollback as leaving the additive schema/relationships in place while restoring the previous application artifact.
- [x] Treat the stage application and verification evidence as a required promotion checkpoint; the sandbox implementation must not connect to or mutate stage.

### 10. Run all validation commands

- [x] Execute every command in Validation Commands in order and resolve every failure before handoff.

## Testing Strategy

### Unit Tests

Test the single-check permission classifier, the reduced decision union, sanitized indeterminate
failures, Action runtime stage ordering, durable denial branch, canonical schema alignment, fixed
environment guards, complete Action discovery, relationship construction, idempotence, and
Codesmith catalog maintenance. Component tests cover all six current Contacts mutation surfaces and both
standalone/federated Toast portals without weakening their existing exhaustive UI-state tests.

### Integration Tests

Use the existing live Core Action permission suite against PostgreSQL and SpiceDB to cover missing,
direct Principal, Tenant membership-set, cross-Tenant, concurrent, and unavailable outcomes through
the real Action repository. Retain the Contacts BFF integration proof for typed internal denial to 403
Problem Details to generated-client error. Perform the two ordered manual Locki checks in one
sandbox, followed later by the operator-controlled stage pre-deploy grant and smoke gate.

### Edge Cases

- An Action object has no executor relationships at all.
- The legacy restriction marker exists without an executor relationship.
- A direct Principal executor exists during N/N-1 overlap.
- An executor references one Tenant's `member` set and the caller belongs to another Tenant.
- The Principal is authenticated but inactive, unbound, or not a member of the fixed Tenant.
- The request is anonymous or has an invalid Shell assertion and must remain a 401 before Action authorization.
- SpiceDB returns conditional/unspecified permission, malformed data, timeout, invalid credentials, unavailable transport, or schema failure.
- Current Action discovery is empty, partial, duplicated, or cannot derive one topology owner's public contract.
- A new Core Action is scaffolded or a new vertical Action appears after this baseline.
- Provisioning is rerun after all, some, or none of the expected relationships already exist.
- Provisioning is invoked in production, with a non-loopback development endpoint, or with a non-stage-private stage endpoint.
- Two callers concurrently receive the same definite denial for one idempotency key.
- Standalone Contacts and Shell-federated Contacts each render one Toast portal and one localized denial Toast.
- A read/loader forbidden state or retryable Action outage does not masquerade as the Action-denial Toast.

## Acceptance Criteria

- [x] A fully consistent SpiceDB `NO_PERMISSION` for `action#execute`, including a completely absent Action relationship, returns `ActionPermissionDenied`; no Policy, service factory, handler, business write, Domain Event, Data Access Event, or Outbox Message runs.
- [x] Missing-rule denial produces the existing single terminal `action.rejected` audit outcome and a rejected invocation, while indeterminate authorization remains `ActionPermissionCheckError` with an open retryable invocation.
- [x] The candidate SpiceDB schema accepts both direct `principal` executors and `tenant#member` executors, remains compatible with the previous schema/runtime during rollout, and is identical in the canonical value and both bootstrap YAML files.
- [x] The current catalog contains 16 unique Actions: eight Core Actions and eight Contacts Actions, and the Core Action Codesmith generator maintains future Core catalog membership automatically.
- [x] `mise exec -- pnpm authorization:provision-current-actions` adds exactly one fixed development Tenant-membership executor per current Action, is safe to rerun, accepts no arbitrary scope input, and rejects unsafe environments/endpoints or incomplete discovery.
- [x] After development provisioning, any authenticated active Principal in the fixed development Tenant can execute each current Action subject to its existing module-state, additional Tenant-role, Policy, and domain checks; anonymous callers, non-members, and other-Tenant Principals are not granted.
- [x] Each definite forbidden result from the eight current Contacts Actions appears once as an accessible, localized UI-kit error Toast on its existing mutation surface in both standalone and Shell-federated rendering.
- [x] Validation, conflict, authentication, unavailable/retry, loading, empty, read-forbidden, responsive, and accessibility behavior remains explicitly handled and does not get reclassified as an Action denial.
- [x] The developer completes and confirms the denial checkpoint and then the post-provisioning allowed checkpoint in the same Locki sandbox, with no stage mutation.
- [x] Before the fail-closed runtime reaches stage, the same command applies and verifies 32 membership-set grants for the 16 current Actions across the two fixed stage Tenants; stage startup/deploy never runs it automatically.
- [x] Existing direct Principal executor grants and the previous runtime remain operable throughout the expand/provision/deploy overlap; rollback does not require reversing the additive schema or relationships.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Validate Action permission classification, lifecycle denial, schema contracts, generated Core catalog, and error typing.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — Validate real PostgreSQL/SpiceDB missing-rule denial, membership-set allowance, cross-Tenant isolation, direct-grant compatibility, concurrency, and unavailable behavior.
- `mise exec -- pnpm --filter @app/contacts test:component` — Validate localized Toast behavior and all existing Contacts page states.
- `mise exec -- pnpm --filter @app/contacts test:integration` — Validate Contacts Action/BFF typed 403 and persistence boundaries.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Validate fixed stage context/bootstrap safety and Shell error contracts.
- `mise exec -- pnpm check:module-contracts` — Validate generated public module contracts and Action descriptors.
- `mise exec -- pnpm contract:check` — Validate Codesmith, startup/deployment, SpiceDB, Module Federation, and explicit-provisioning workspace contracts.
- `mise exec -- pnpm i18n:boundaries` — Validate any reused or changed Toast copy remains inside Contacts's English/Czech namespace boundary.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- ADR-0019 is accepted and defines missing configuration as denial while the default explicit rule grants the authenticated, active membership set of the trusted Tenant.
- This is a feature, not a bug fix: the current fail-open result is explicitly documented and tested as a compatibility case, so changing it establishes a new authorization guarantee.
- “Allow every authenticated user” is intentionally scoped to every authenticated, active Principal who is a member of one specific fixed Tenant. It is not an anonymous grant, cross-Tenant grant, production wildcard, or bypass of module state, additional Tenant permissions, Policies, or domain invariants.
- The current Action baseline is 16: `core.identity.bind-managed-api-key`, `core.identity.bind-self-api-key`, `core.identity.change-principal-status`, `core.identity.create-non-human-principal`, `core.identity.record-support-impersonation`, `core.identity.set-managed-api-key-binding-status`, `core.identity.set-self-api-key-binding-status`, `core.modules.change-tenant-module-state`, and the eight `contacts.core` create/edit/archive/unarchive Customer/Contact Actions.
- The legacy restriction marker is retained only for rollout compatibility. Removing its relation, permission, fixtures, and old tuples is a later contract step after N/N-1 overlap ends.
- The UI-kit workflow requires the existing Toast component, one portal at the application/federated boundary, `useToast()` for transient Action feedback, no custom Toast styling, and app-level UI-kit audit during review. No shared UI-kit source or token change is expected.
- Actual stage relationship writes are deliberately not performed while implementing or testing in the sandbox. They are an operator-owned promotion gate executed later from the reviewed candidate artifact.
