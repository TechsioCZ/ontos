---
type: feature
status: done
created: 2026-07-31
---

# Feature: Action Permissions

## Feature Description

Gate every typed Action at the existing permission stage with a Core-owned
SpiceDB authorization service. Losslessly encode each Action descriptor's stable,
globally unique `actionKey` as an `ak_`-prefixed base64url SpiceDB Action object
identifier, keep the existing trusted OntOS `principalId` as the subject identifier, and make the
permission check run after the durable invocation has been created but before
the invocation becomes `running`, the business transaction opens, or the
private handler can execute.

Preserve the requested compatibility rule that an Action with no SpiceDB
restriction record is allowed. Represent that rule explicitly in the SpiceDB
schema: an `action` object whose id is the encoded Action key is restricted only when it has a
self-referential restriction-marker relationship. An unconfigured Action has
no marker and is allowed; a restricted Action must grant the `execute`
permission to the `principal` object whose id is the trusted principal id,
otherwise it is denied. A valid
negative marker check is the only fail-open path. Missing configuration,
network failures, timeouts, schema errors, conditional decisions, and other
indeterminate SpiceDB responses are typed infrastructure failures and fail
closed.

On a definite denial, atomically transition the independently persisted
Action Invocation from `received` to terminal `rejected`, set `completed_at`,
and insert one terminal `action.rejected` Audit Event with normalized authz
outcome data. Only after that evidence transaction commits may Core return a
typed `ActionPermissionDenied` carrying a safe human-readable reason. No
handler, business transaction, business write, Data Access Event, Domain
Event, or Outbox Message may occur on the denied path.

## User Story

As an OntOS administrator
I want Action execution to honor centrally managed SpiceDB permissions
So that unauthorized state changes are blocked and leave durable evidence

## Problem Statement

The Action runtime currently exposes explicit authentication, permission, and
policy stage boundaries, but the permission boundary is deliberately deferred
and performs no check. Consequently every structurally valid request with a
trusted principal can advance to `running` and invoke its handler regardless
of SpiceDB relationships. Core also has no SpiceDB client/configuration layer,
local SpiceDB service, typed authorization failures, or denial evidence path.

The current authoritative `docs/architecture/ACTIONS.md` says rejected or
failed attempts remain open and produce no Audit Event, while issue 71
specifically requires a permission denial to update `action_invocations` and
create an `audit_events` row. The implementation must therefore make authz
denial a narrow documented terminal-rejection exception without changing the
existing open-invocation behavior for domain rejection, handler failure, or
infrastructure failure.

## Solution Statement

Add a pinned local SpiceDB container and a Core-owned bootstrap authorization
schema, then wrap the official Node client in a scoped Effect service with
typed configuration and check failures. The service performs fully consistent
permission checks because no relationship-write/ZedToken flow exists yet:
first check the Action's self-marker permission, return an explicit
`unconfigured` allow decision when the marker is absent, and otherwise check
the principal's `execute` permission. Feed that service into
`makeActionRuntime`, replacing `permission_boundary_deferred` with a real
permission stage before the `running` transition.

Extend the Core Action error union with a safe denial error and a separate
fail-closed permission-check infrastructure error. Add a typed repository
operation that serializes concurrent denials, atomically persists exactly one
terminal denial Audit Event and the `rejected` invocation transition, and is
idempotent when the same invocation has already been rejected. Existing Core
schema types and constraints already support `rejected`, `completed_at`,
`outcome = denied`, and `outcome_stage = authz`, so this feature requires no
Core Drizzle schema change or migration.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — application scope, read-only directories, and mandatory
  Codesmith rules; no Action or Policy is created by this infrastructure
  feature, so no generator applies.
- `AGENTS.md` — authoritative Core, Action, Effect error, database, and
  toolchain constraints.
- `README.md` — workspace shape, strict Effect topology, and local command
  conventions.
- `docs/architecture/ACTIONS.md` — authoritative Action stage order and
  rejection/evidence lifecycle that must describe the new permission gate and
  the terminal authz-denial exception.
- `docs/architecture/ERRORS.md` — typed Effect error and eventual BFF HTTP
  mapping rules; permission denial maps to `403` and permission-service
  unavailability maps to `503`.
- `docs/architecture/DATABASE.md` — typed Drizzle/Effect persistence and Core
  schema-ownership rules for the denial evidence transaction.
- `docs/architecture/MICROVERTICALS.md` — Core authorization must remain
  shared infrastructure and must not introduce imports across business
  MicroVertical seams.
- `docs/architecture/ULTRAMODERN.md` — infrastructure-file exception,
  Effect-first implementation rules, and prohibition on ad hoc business file
  creation.
- `../docs/06_CORE_KERNEL.md` — product architecture assigning the SpiceDB
  adapter and Action enforcement to Core.
- `../docs/07_RUNTIME_CONSISTENCY_MODEL.md` — normalized authz Audit Event
  outcomes, codes, and terminal `rejected` invocation semantics.
- `../docs/09_AUTHN_AUTHZ_MODEL.md` — separation of BetterAuth authentication,
  OntOS principals, SpiceDB relationship authorization, and business policy.
- `../docs/evidence/mvp/22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md` — evidence
  transaction and handler non-execution requirements for denied writes.
- `../docs/evidence/mvp/23_CORESDK_OPERATION_FLOW_DESIGN.md` — Action permission ordering,
  `403` semantics, and audit checkpoint guidance.
- `docker-compose.yml` — local `ontos` Compose project that must gain the
  correctly named, pinned SpiceDB service.
- `.env.example` — non-secret local SpiceDB endpoint, ports, development key,
  and explicit insecure-local-client configuration.
- `package.json` — root Action test orchestration and final quality gate.
- `pnpm-workspace.yaml` — dependency policy that the official SpiceDB client
  must satisfy.
- `pnpm-lock.yaml` — lockfile updated by the repository-managed pnpm install.
- `packages/core-runtime/package.json` — Core ownership of the official
  SpiceDB Node client and focused permission/runtime test scripts.
- `packages/core-runtime/src/actions/definition.ts` — existing globally unique
  `actionKey` descriptor contract losslessly mapped to the SpiceDB Action identifier.
- `packages/core-runtime/src/actions/errors.ts` — transport-neutral Core Action
  error union and status-mapping guidance.
- `packages/core-runtime/src/actions/repository.ts` — typed Drizzle repository
  operations for invocation and Audit Event persistence.
- `packages/core-runtime/src/actions/runtime.ts` — deferred permission boundary
  to replace with the real pre-handler authorization gate.
- `packages/core-runtime/src/db/schema.ts` — existing `rejected` invocation and
  authz Audit Event constraints that prove a migration is unnecessary.
- `packages/core-runtime/src/index.ts` — narrow public Action errors/runtime
  surface; the raw SpiceDB client must remain private.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — descriptor
  tests for stable Action-key permission identity.
- `packages/core-runtime/tests/unit/action-errors.test.ts` — exhaustive public
  Core Action error-tag and safe-message tests.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — stage ordering,
  fake permission decisions, fail-closed behavior, and handler non-execution
  tests.
- `packages/core-runtime/tests/unit/action-public-surface.test.ts` — proves the
  authorization adapter/client does not leak through the public package API.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — existing
  PostgreSQL Action lifecycle tests that must keep all non-authz failure
  behavior unchanged and exercise denial-persistence rollback.

### New Files

- `packages/core-runtime/spicedb/bootstrap.yaml` — Core-owned local SpiceDB
  bootstrap schema and schema validation fixtures for the Action restriction
  marker and `execute` grant.
- `packages/core-runtime/src/permissions/config-error.ts` — typed, sanitized
  SpiceDB configuration failure.
- `packages/core-runtime/src/permissions/config.ts` — root-environment loading
  and validation for endpoint, pre-shared key, and explicit local insecure
  mode.
- `packages/core-runtime/src/permissions/service.ts` — scoped Effect wrapper
  around the official SpiceDB client and the typed Action permission-decision
  contract.
- `packages/core-runtime/tests/unit/action-permission.test.ts` — configuration,
  request mapping, decision classification, timeout/unavailability, and client
  finalization tests.
- `packages/core-runtime/tests/integration/action-permission.test.ts` — live
  SpiceDB plus PostgreSQL proof of unconfigured allow, configured allow,
  configured denial, fail-closed unavailability, and durable denial evidence.

## Implementation Plan

### Phase 1: Foundation

Add the pinned `authzed/spicedb:v1.56.0` local service as
`ontos-spicedb`, mount a Core-owned bootstrap schema, expose the gRPC and HTTP
development ports, authenticate with a non-secret development-only pre-shared
key from `.env.example`, and add a gRPC health check. Install the official
`@authzed/authzed-node@1.6.1` client exactly in `@app/core-runtime`. Build a
scoped Effect configuration/client service that never silently downgrades TLS,
never exposes the key, raw client, or raw gRPC errors, and distinguishes valid
negative decisions from service failure.

The bootstrap schema defines `principal` and `action`. Each Action can have a
self-referential `restriction` marker and an `executor` relation to a
principal. `permission is_restricted = restriction` answers whether an Action
has a permission record; `permission execute = executor` answers whether the
current principal may execute a restricted Action. The marker tuple uses the
lossless SpiceDB-safe encoding, for example
`action:ak_aW52ZW50b3J5LnN0b2NrLnJlc2VydmU#restriction@action:ak_aW52ZW50b3J5LnN0b2NrLnJlc2VydmU`.

### Phase 2: Core Implementation

Map `ActionDescriptor.actionKey` losslessly to `ak_` plus unpadded base64url so
the existing dotted keys satisfy SpiceDB's object-id alphabet, and make its
global uniqueness and immutability explicit in the descriptor contract.
Return a typed decision union from the permission service:
`unconfigured` (valid negative marker check, allow), `allowed` (marker and
execute checks both positive), or `denied` (marker positive, execute negative).
Map conditional/unknown decisions, timeouts, invalid schema responses, client
errors, and missing configuration to typed fail-closed errors rather than
conflating them with an absent marker.

Extend the Action runtime so the permission decision occurs after invocation
creation/idempotency verification and before the `received`-to-`running`
transition. On denial, call a new repository operation that locks the
invocation, inserts exactly one `action.rejected` Audit Event with
`outcome = denied`, `outcome_stage = authz`, and
`outcome_code = spicedb_permission_denied`, and updates the invocation to
`rejected` with `completed_at` in one Core transaction. Return the typed denial
only after that commit. Preserve the current open invocation and no-audit
behavior for SpiceDB infrastructure failure and all non-authz failures.

### Phase 3: Integration

Wire the live permission Effect layer into `ActionRuntimeLive` while keeping
the raw client private and fakeable through `makeActionRuntime` tests. Expand
unit tests beside each behavior, then add a live Compose-backed integration
suite that writes isolated relationships, proves all three decision states,
asserts the exact Action/principal identifiers, and verifies that denied
attempts create only the terminal invocation/audit evidence. Keep the existing
successful Action transaction, idempotency, concurrency, rollback,
indeterminate-commit, and commit-resolution tests green.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Add the local SpiceDB service and authorization schema

- [x] Update `docker-compose.yml` with service key and `container_name`
      `ontos-spicedb`, pinned image `authzed/spicedb:v1.56.0`, memory datastore
      for local development, pre-shared-key authentication, gRPC/HTTP port
      mappings, a read-only bootstrap mount from
      `packages/core-runtime/spicedb/bootstrap.yaml`, and a gRPC readiness
      health check; do not couple SpiceDB storage to the Core-owned `core`
      PostgreSQL schema.
- [x] Extend `.env.example` with non-secret development values for
      `SPICEDB_ENDPOINT=localhost:50051`, `SPICEDB_GRPC_PORT=50051`,
      `SPICEDB_HTTP_PORT=8443`, `SPICEDB_PRESHARED_KEY`, and
      `SPICEDB_INSECURE=true`; keep production TLS/secret provisioning outside
      committed configuration and never read or overwrite a developer's
      `.env`.
- [x] Create `packages/core-runtime/spicedb/bootstrap.yaml` with the minimal
      `principal`/`action` schema, self-referential restriction marker,
      `is_restricted` and `execute` permissions, and validation fixtures that
      prove absent marker, restricted grant, and restricted denial semantics.
- [x] Do not run an Action or Policy Codesmith generator: this step adds
      Core-owned authorization infrastructure and does not create either
      supported business file type.
- [x] Validate Compose interpolation, the exact container name, bootstrap
      mount, pinned image, ports, and readiness behavior with the matching
      commands under Validation Commands.

### 2. Add the scoped Effect SpiceDB client and decision service

- [x] From `app/`, install the exact official client with
      `mise exec -- pnpm --filter @app/core-runtime add --save-exact @authzed/authzed-node@1.6.1`
      so `packages/core-runtime/package.json` and `pnpm-lock.yaml` remain owned
      by the repository-managed toolchain.
- [x] Add typed configuration loading in
      `packages/core-runtime/src/permissions/config.ts` and
      `config-error.ts`, following the database configuration's explicit root
      path and Effect Layer pattern; validate a non-empty endpoint/key and
      require an explicit insecure-local flag rather than silently disabling
      transport security.
- [x] Add `packages/core-runtime/src/permissions/service.ts` as a scoped
      Effect service around the official client, close its gRPC resources on
      scope release, apply bounded request deadlines, use fully consistent
      checks, and attach safe correlation metadata without logging the
      pre-shared key.
- [x] Implement the two-check algorithm with constants for object/permission
      names: check `is_restricted` on the Action object whose id is the lossless
      `ak_`-prefixed base64url encoding of the Action key, using that same Action
      object as subject; return
      `unconfigured` only for a valid
      `NO_PERMISSION`, otherwise check
      `execute` on that Action object for the `principal` object whose id is
      the trusted principal id, and classify the positive/negative result as
      `allowed`/`denied`.
- [x] Map conditional/unknown permissionship, deadlines, unavailable service,
      authentication failure, schema mismatch, and malformed client responses
      to a sanitized typed permission-check error. These paths must fail
      closed and must never be reclassified as an absent Action record.
- [x] Add `action-permission.test.ts` unit tests for root-independent config
      discovery, missing/malformed config, explicit insecure-local handling,
      exact Action/principal identifier mapping, fully consistent checks, all
      decision states, bounded failure, secret sanitization, and client
      finalization.

### 3. Extend the typed Core Action error contract

- [x] Add `ActionPermissionDenied` with stable code
      `action_permission_denied` and a safe human-readable `reason` message,
      plus a distinct `ActionPermissionCheckError` with stable code
      `action_permission_check_failed`, to
      `packages/core-runtime/src/actions/errors.ts`.
- [x] Add both errors to `ActionCoreError`, `ACTION_CORE_ERROR_TAGS`, the
      public exports in `packages/core-runtime/src/index.ts`, and the
      transport-neutral status guidance: denial is eventually mapped
      exhaustively to HTTP `403`; an unavailable/indeterminate permission
      capability maps to `503`.
- [x] Update `action-errors.test.ts` to prove the exhaustive tag order, stable
      codes, safe denial reason, absence of credentials/internal details, and
      continued transport neutrality; update `action-public-surface.test.ts`
      to prove only the typed errors are exported and the raw client/config
      service stays private.
- [x] Update `docs/architecture/ERRORS.md` with the new internal-to-public
      mappings while preserving the rule that each future Action BFF contract
      must declare its public `403`/`503` Problem Details schemas. Do not add a
      generic Action HTTP endpoint merely to exercise status mapping.

### 4. Persist permission denials as terminal evidence

- [x] Add a typed `rejectPermissionDenied` repository operation in
      `packages/core-runtime/src/actions/repository.ts` that opens a Core-owned
      Drizzle transaction, locks the invocation, and accepts only the matching
      open `received` state or an already completed `rejected` state for the
      same invocation.
- [x] In that transaction, insert exactly one terminal Audit Event with
      `event_type = action.rejected`, `outcome = denied`,
      `outcome_stage = authz`,
      `outcome_code = spicedb_permission_denied`, the descriptor audit
      profile, trusted actor/tenant/legal-entity and target context, and only
      small redacted evidence such as the stable Action key; then update the
      invocation to `status = rejected` with `completed_at` set.
- [x] Make concurrent persistence for the same denied idempotent invocation
      serialize on the invocation lock and produce one Audit Event. Reject an
      incompatible lifecycle state through the existing typed invocation
      state/persistence errors rather than overwriting it.
- [x] If either the Audit Event insert or invocation update fails, roll back
      both writes, return a typed infrastructure error, keep the handler
      unexecuted, and do not return a denial response that falsely claims the
      required evidence was persisted.
- [x] Extend unit repository/runtime fakes and PostgreSQL integration tests to
      prove atomic denial persistence, duplicate/concurrent denial behavior,
      audit-insert rollback, invocation-update rollback, no secret/payload
      evidence, and no change to existing non-authz open-invocation behavior.

### 5. Enforce permission before Action execution

- [x] Inject the permission decision service into `makeActionRuntime` and
      `ActionRuntimeLive`; update every test runtime construction with an
      explicit fake decision so no unit test accidentally depends on a live
      external service.
- [x] In `runAction`, perform authorization after
      `createOrResolveInvocation` and `verifyInvocation`, notify a real
      `permission_checked` stage instead of
      `permission_boundary_deferred`, and retain
      `policy_boundary_deferred` after a permission allow.
- [x] For `unconfigured` and `allowed`, continue to the existing independent
      `running` transition and business transaction without changing handler
      inputs or exposing permission control flow to a MicroVertical.
- [x] For `denied`, persist the terminal rejection evidence and then fail with
      `ActionPermissionDenied`; never transition the invocation to `running`,
      acquire the business transaction, create a collector, or invoke the
      handler.
- [x] For permission configuration/client/check failure, fail closed with the
      typed infrastructure error, leave the invocation open in `received`
      without pretending a denial occurred, and never execute the handler.
- [x] Update `action-runtime.test.ts` with ordered-stage assertions and spies
      proving Action-key identity, unconfigured allow, configured allow,
      denial, check failure, idempotency/hash checks before authorization,
      no handler/business transaction on blocked paths, and unchanged policy
      placement.
- [x] Update `docs/architecture/ACTIONS.md` to replace the deferred permission
      increment, document the absent-marker compatibility rule and fail-closed
      infrastructure behavior, and define terminal authz denial as the narrow
      exception to the otherwise-open definite-rejection lifecycle.

### 6. Prove the live SpiceDB and PostgreSQL integration

- [x] Add `packages/core-runtime/tests/integration/action-permission.test.ts`
      and update the package's `action:test:integration` script to include all
      Action integration tests without weakening `db:test`.
- [x] Against the healthy Compose service, use the official client to create
      isolated Action/principal relationships and clean them after the suite;
      do not depend on global developer permission fixtures or mutate a
      production authorization graph.
- [x] Prove an Action without a restriction marker is allowed, a marked Action
      with an executor relationship is allowed, and a marked Action without
      an executor relationship returns the typed denial with its safe reason.
- [x] For the denied case, prove the handler counter remains zero, no test
      business row/Data Access Event/Domain Event/Outbox Message exists, the
      invocation is terminal `rejected` with `completed_at`, and exactly one
      linked `action.rejected` Audit Event has the normalized authz outcome.
- [x] Prove SpiceDB outage or invalid credentials return the typed fail-closed
      check error, do not run the handler, do not create denial evidence, and
      leave the invocation retryable in `received`.
- [x] Re-run the existing Action integration suite to prove success atomicity,
      handler/domain rejection rollback, concurrency, idempotency conflict,
      indeterminate commit, and commit resolution have not regressed.

### 7. Run every validation command

- [x] Execute every command listed under Validation Commands in order and
      resolve failures without weakening authorization, typed errors, denial
      evidence atomicity, Core database ownership, or existing workspace
      gates.
- [x] Inspect `git status --short` and `git diff --check` afterward; confirm no
      `.env`, SpiceDB credentials, local datastore data, generated build
      output, unrelated application changes, or manual Action/Policy scaffold
      is included.

## Testing Strategy

### Unit Tests

Use a fake official-client seam and explicit permission service fakes to test
configuration parsing, secure/insecure client construction, resource and
subject mapping, the two-check decision table, fully consistent requests,
timeouts, typed sanitization, client finalization, stage order, and every
runtime branch. Assert that the existing descriptor `actionKey` is mapped
losslessly and collision-free and that different Action keys address different SpiceDB objects.
Exercise the denial repository contract with fake transaction executors so
Audit Event and invocation-update failures cannot partially persist or allow
the handler to run. Keep the exhaustive Action error union and narrow public
surface tests aligned.

### Integration Tests

Run PostgreSQL and the pinned SpiceDB container from Compose. Use unique
tenant, principal, Action, target, and idempotency identifiers. Create only
suite-owned SpiceDB relationships, exercise unconfigured/allowed/denied and
unavailable paths through the real Action runtime, inspect typed Drizzle rows
for invocation/audit/business/evidence results, and clean only suite-owned
fixtures. Retain the full existing PostgreSQL Action runtime suite as the
cross-boundary regression proof.

### Edge Cases

- The Action has no restriction marker: allow only after a successful,
  fully-determined negative `is_restricted` check.
- The Action has a restriction marker but no executor grant: deny, persist one
  terminal evidence transaction, and return the safe typed reason.
- The Action marker and executor grant both exist: allow and execute once.
- SpiceDB is unavailable, times out, rejects credentials, has no expected
  schema, or returns conditional/unknown permissionship: fail closed without
  classifying the Action as unconfigured.
- The denial Audit Event insert or invocation update fails: roll back both,
  return infrastructure failure, and never invoke the handler.
- Two concurrent requests share one denied idempotency key: serialize the
  denial transition, create one Audit Event, and execute no handler.
- A denied terminal invocation is retried with the same idempotency key: do
  not reauthorize or execute it; preserve terminal invocation semantics. A
  newly granted principal uses a new user-intent idempotency key.
- The same idempotency key has a different request hash: retain the existing
  conflict result before any permission check.
- Action keys contain the repository's namespaced dotted format, while SpiceDB
  object ids reject dots: use the documented lossless `ak_` plus unpadded
  base64url mapping and never derive identity from a display label, route,
  payload, or target.
- No principal or permission relationship contains tenant payload data:
  authorization uses the trusted globally unique OntOS principal id, never a
  caller-supplied subject.

## Acceptance Criteria

- [x] `docker-compose.yml` defines healthy container `ontos-spicedb` from
      pinned image `authzed/spicedb:v1.56.0` with the committed Core-owned
      bootstrap schema and non-secret `.env.example` contract.
- [x] `@app/core-runtime` uses pinned official client
      `@authzed/authzed-node@1.6.1` behind a scoped, private Effect service with
      typed configuration and check failures.
- [x] Every Action's existing stable, globally unique `actionKey` is losslessly
      encoded into its SpiceDB Action object identifier and is documented as immutable once
      relationships reference it.
- [x] A valid negative restriction-marker check allows an unconfigured Action;
      a restricted Action executes only when the trusted principal has the
      `execute` permission.
- [x] SpiceDB outage, timeout, authentication/schema error, and
      conditional/unknown decisions fail closed and never become the
      no-record allow case.
- [x] Permission evaluation occurs after durable invocation/idempotency
      handling and before `running`, the business transaction, collector, and
      handler.
- [x] A definite denial returns `ActionPermissionDenied` with stable code and
      safe human-readable reason; status guidance maps it to public HTTP
      `403` without adding a generic Action endpoint.
- [x] A definite denial executes no handler and atomically leaves one
      `rejected` invocation with `completed_at` plus exactly one linked
      `action.rejected` Audit Event with outcome `denied`, stage `authz`, and
      code `spicedb_permission_denied`.
- [x] Denied and failed permission paths persist no business write, Data
      Access Event, Domain Event, or Outbox Message.
- [x] Denial evidence persistence failure rolls back both Core evidence writes,
      remains typed, and does not execute the handler.
- [x] Existing successful, domain-rejected, failed, concurrent, idempotent,
      and indeterminate Action behavior remains covered and unchanged outside
      the documented authz-denial exception.
- [x] The raw SpiceDB client, credentials, and private authorization service
      are absent from browser/public package surfaces and audit evidence.
- [x] No Core Drizzle schema or migration is changed because the existing
      lifecycle and Audit Event constraints already support this behavior.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `docker compose --env-file .env.example config` — validate the Compose
  project, exact service/container naming, pinned image, bootstrap mount,
  ports, health check, and environment interpolation without reading `.env`.
- `docker compose --env-file .env.example up -d --wait ontos-db ontos-spicedb`
  — start the isolated local PostgreSQL and SpiceDB dependencies and wait for
  both health checks.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos mise exec -- pnpm db:migrate`
  — apply the existing Core/Auth migrations to the local validation database;
  no new Core migration should be generated by this feature.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — run the
  Action descriptor, permission adapter, error, runtime, and public-surface
  unit tests.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos SPICEDB_ENDPOINT=localhost:50051 SPICEDB_PRESHARED_KEY=ontos-local-development-key SPICEDB_INSECURE=true mise exec -- pnpm --filter @app/core-runtime action:test:integration`
  — prove the live PostgreSQL/SpiceDB permission gate and all existing Action
  integration behavior using only committed development defaults.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters BETTER_AUTH_URL=http://localhost:3020 BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3020,http://127.0.0.1:3020 mise exec -- pnpm db:verify` — verify all typed Core/Auth PostgreSQL schema
  references and confirm that SpiceDB introduced no table into an OntOS-owned
  PostgreSQL schema.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- The request is classified as a Feature because it adds a new security and
  evidence capability to every Action.
- No implementation blocker remains. This plan makes the required “no record
  means allow” behavior concrete with an explicit self-referential restriction
  marker. A plain SpiceDB `CheckPermission` negative result cannot by itself
  distinguish an absent Action configuration from a configured Action without
  a grant, so the two-check schema contract is required.
- Fail-open behavior is intentionally limited to a valid negative marker
  decision because issue 71 explicitly requires backward-compatible allow for
  unconfigured Actions. All service and decision uncertainty fails closed.
- The local Compose service deliberately uses SpiceDB's in-memory datastore;
  relationship data is disposable and the committed bootstrap restores the
  schema. Production datastore topology, TLS/secret provisioning, high
  availability, backups, and relationship-administration workflows are
  separate deployment/security work and do not block this runtime gate.
- Action/role administration and SpiceDB relationship-write consistency are
  outside issue 71. This feature reads relationships and uses isolated test
  writes only; future access-management Actions must define ordering,
  recovery, audit, and ZedToken propagation before production use.
- Fully consistent checks are the conservative choice until a relationship
  write path can propagate ZedTokens. A later measured optimization may use
  `at_least_as_fresh` without changing the permission service contract.
- Primary technical references used to settle the plan are the official
  [SpiceDB schema language](https://authzed.com/docs/spicedb/concepts/schema),
  [permission query semantics](https://authzed.com/docs/spicedb/concepts/querying-data),
  [schema validation guidance](https://authzed.com/docs/spicedb/modeling/validation-testing-debugging),
  [official Node client releases](https://github.com/authzed/authzed-node/releases),
  and [SpiceDB v1.56.0 release](https://github.com/authzed/spicedb/releases/tag/v1.56.0).

## Implementation Evidence

### Summary

- Added the pinned, healthy local SpiceDB service, development configuration contract, and
  Core-owned authorization schema with fixtures for absent, granted, and denied relationships.
- Added a private, scoped Effect adapter around exact `@authzed/authzed-node@1.6.1`, strict typed
  configuration, two fully consistent checks, a two-second deadline, resource finalization,
  sanitized fail-closed errors, and safe trace correlation attributes.
- Losslessly map dotted OntOS Action keys to SpiceDB-safe `ak_`-prefixed base64url object ids while
  retaining the canonical Action key in the runtime, invocation, and audit evidence contracts.
- Replaced the deferred Action permission boundary with the real gate after invocation/idempotency
  verification and before `running`, transaction acquisition, collector creation, or handler entry.
- Kept handlers outside the public Action registration object and made Core `runAction` the only
  package-supported path that can resolve and invoke them.
- Added atomic terminal-denial persistence and typed denial/check failures with documented future
  HTTP `403`/`503` mappings. All focused, live integration, repository, and build validation passes.

### Changed Files

- 16 tracked files contain 705 additions and 31 deletions. Six new implementation files add 1,206
  lines. This 646-line specification is the seventh new file.
- Compose/config/schema: `.env.example`, `docker-compose.yml`, and
  `packages/core-runtime/spicedb/bootstrap.yaml`.
- Permission adapter: three files under `packages/core-runtime/src/permissions/`.
- Action contract/runtime/persistence: `definition.ts`, `errors.ts`, `repository.ts`, `runtime.ts`,
  `index.ts`, and the Action/error architecture documents.
- Dependency/test wiring: `packages/core-runtime/package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, existing Action tests, and two new permission test files.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/action-permission.test.ts`: strict root configuration, TLS rules,
  collision-free Action-key encoding, exact trusted principal identity, fully consistent decision
  table, malformed/conditional/client failures, bounded deadlines, sanitization, and finalization.
- `packages/core-runtime/tests/unit/action-runtime.test.ts`: exact permission stage/order/input,
  configured and
  unconfigured allow, denial non-execution, fail-closed checks, denial-persistence failure, and
  pre-authorization idempotency/hash terminal behavior.
- Updated Action error/public-surface tests and the existing PostgreSQL Action runtime suite's
  explicit permission seam.
- Updated Action definition tests to prove an exported registration exposes its immutable descriptor
  without exposing a directly callable handler.
- `packages/core-runtime/tests/integration/action-permission.test.ts`: isolated live
  SpiceDB/PostgreSQL fixtures,
  unconfigured and granted execution, normalized atomic denial, concurrent denial idempotency,
  both denial rollback points, and invalid-credential fail-closed behavior.

### Validation

- `docker compose --env-file .env.example config` — passed.
- `docker compose --env-file .env.example up -d --wait ontos-db ontos-spicedb` — passed; both
  containers reached healthy state with SpiceDB `v1.56.0` bootstrapped from the committed schema.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos mise exec -- pnpm db:migrate` — passed;
  existing Core and Auth migrations applied and no migration was generated.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed, 48/48 tests.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos SPICEDB_ENDPOINT=localhost:50051 SPICEDB_PRESHARED_KEY=ontos-local-development-key SPICEDB_INSECURE=true mise exec -- pnpm --filter @app/core-runtime action:test:integration`
  — passed, 16/16 live PostgreSQL/SpiceDB Action integration tests.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters BETTER_AUTH_URL=http://localhost:3020 BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3020,http://127.0.0.1:3020 mise exec -- pnpm db:verify`
  — passed; verified 18 Core tables and four Auth tables.
- `mise exec -- pnpm check` — passed, including format, lint, focused tests, typecheck, skills,
  i18n, API, workspace-contract, and performance gates.
- `mise exec -- pnpm build` — passed, including server/client production build, TS-Go compile,
  Module Federation type assertion, deployment packaging, and performance readiness.
- `git diff --check` — passed; final status contains only feature files and this plan. No `.env`,
  datastore, generated build output, business scaffold, or production credential is present.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, the implementation plan/acceptance criteria, and the
  relevant Action, Effect error, database, MicroVertical, UltraModern, Core, consistency,
  authentication/authorization, and CoreSDK guidance.
- Confirmed the change remains Core-owned infrastructure, adds no cross-MicroVertical import or
  BFF/public-client expansion, uses typed Drizzle references and Effect errors, changes no schema
  or migration, and does not require a Codesmith-supported business scaffold.
- Review fixes removed retention/logging of raw gRPC causes, tightened denial lookup to the exact
  Action/tenant/principal tuple, rejected endpoint query/fragment suffixes, removed the unsupported
  SpiceDB `v1.56.0` plaintext flag, introduced the required lossless object-id encoding, removed the
  public registration handler bypass, and made integration cleanup exact and resilient.
- No frontend files changed, so browser validation and screenshots are not applicable.

### Deviations and Follow-ups

- The originally drafted `@authzed/authzed-node@1.7.0` does not exist. Per developer direction, the
  implementation uses the latest published version, exact `1.6.1`.
- SpiceDB object ids reject the repository's dotted Action-key format. The adapter therefore applies
  the documented reversible `ak_` plus unpadded base64url mapping; no canonical OntOS identity or
  evidence value changed.
- Production SpiceDB persistence, TLS/secret provisioning, relationship administration, and
  ZedToken propagation remain intentionally outside issue 71. No implementation blocker remains.
