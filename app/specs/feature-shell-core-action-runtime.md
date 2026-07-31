---
type: feature
status: done
created: 2026-07-29
---

# Feature: Shell/Core Action Runtime

## Feature Description

Add the first server-side Action execution runtime to Shell/Core. An Action is
a typed command or intent, such as creating, changing, or deleting one or more
business entities. A Domain Event is a business fact that occurred as a result
of a successful Action.

The runtime accepts a typed Action registration, a payload, and a trusted
principal context supplied separately from that payload. Shell/Core owns the
Action Invocation lifecycle and the database transaction; the owning Action
handler receives the trusted principal, typed payload, a transaction-scoped
database executor, and controlled methods for recording Data Access Events,
adding Domain Events, and adding Outbox Messages.

Every structurally valid Action creates an Action Invocation Log before the
business transaction. The handler's business changes, successful execution
audit record, Data Access Events, Domain Events, Outbox Messages, and successful
Action Invocation update commit atomically. If handler execution or the
transaction fails, all transactional records roll back, the invocation remains
open, no read data reaches the client, and the caller receives a typed Effect
error. Open failed invocations are intentionally not finalized in this
increment.

An Outbox Message can be added only with a Domain Event registered by the same
Action execution. A repeated idempotency key may retry an open invocation when
the request hash matches. Once the earlier transaction has committed, the same
idempotency key fails with a typed already-committed error; the runtime does not
store or replay the original response.

## User Story

As an OntOS module developer
I want Shell/Core to execute typed Actions through one transaction and evidence lifecycle
So that business writes, access records, Domain Events, and Outbox Messages remain consistent and auditable

## Problem Statement

OntOS has authoritative Action lifecycle and database schemas but no executable
Shell/Core Action runtime. Shell and future MicroVertical BFF handlers therefore
cannot yet submit typed commands to one shared runtime that separates trusted
identity from user payload, owns transactions, records successful reads and
results, binds Outbox Messages to Domain Events, preserves typed failures, and
enforces idempotency.

The Core database foundation exposed raw typed Drizzle
execution but not Action descriptors, private handlers, execution context,
evidence collectors, idempotency coordination, or transaction orchestration.
The documented lifecycle also needs to reflect the agreed behavior that a
definitely failed transaction leaves its Action Invocation open and persists no
terminal failure or Data Access Event.

## Solution Statement

Implement an Effect-based Action runtime in `@app/core-runtime` using typed
object/interface composition rather than an inheritance hierarchy:

- An Action descriptor owns its stable key and Effect Schema payload/result
  contracts, declared domain-error schema, and permitted Domain Event payload
  schemas.
- A private handler is paired with the descriptor in an Action registration.
- `runAction` receives the registration, unknown payload, trusted principal
  context, and transport/idempotency metadata as separate values.
- Core decodes the payload before entering the lifecycle, inserts or resolves
  the Action Invocation, serializes concurrent use of its idempotency key, and
  opens the Drizzle transaction.
- The handler receives the decoded payload and a restricted execution context
  containing the principal, transaction executor, and append-only collector
  methods. It cannot commit or roll back the transaction.
- `addDomainEvent` returns an execution-local typed reference.
  `addOutboxMessage` requires that reference and rejects foreign or missing
  Domain Events before persistence.
- On handler success, Core persists the result audit record, recorded Data
  Access Events, Domain Events, Outbox Messages, and the `succeeded` invocation
  update in the same transaction as the business writes.
- On a typed handler rejection, defect, persistence failure, or definite
  rollback, Core returns a transport-neutral typed Effect error and leaves the
  invocation open.
- If commit acknowledgement is lost, Core returns a typed indeterminate result
  until its explicit commit-resolution operation can query and lock the
  invocation. A committed `succeeded` update proves the transaction committed;
  an open invocation permits a same-hash retry after the original database
  lock is released.
- Upper BFF layers remain responsible for exhaustively mapping Core and domain
  errors to declared HTTP error schemas and statuses.

The runtime is packaged infrastructure. This feature does not create a
production business Action or generic untyped `/actions` endpoint. Tests use
test-local Action registrations, so the currently unavailable Codesmith Action
generator is intentionally not invoked.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and the mandatory generator rule that applies when a production Action is created.
- `AGENTS.md` — authoritative MicroVertical, Action, Effect error, database, and managed-toolchain guidance.
- `README.md` — workspace topology and strict Effect BFF conventions.
- `docs/architecture/ACTIONS.md` — authoritative Action lifecycle to update with the agreed open-failure and transaction semantics.
- `docs/architecture/MICROVERTICALS.md` — independently deployable vertical and generated Effect BFF seams.
- `docs/architecture/ERRORS.md` — typed Effect error and upper-layer HTTP mapping requirements.
- `docs/architecture/DATABASE.md` — typed Drizzle access, Effect service, schema ownership, and transaction rules.
- `docs/architecture/ULTRAMODERN.md` — Effect-first implementation and generator constraints.
- `../docs/06_CORE_KERNEL.md` — Core ownership of Action invocation, audit, domain event, outbox, and principal infrastructure.
- `../docs/07_RUNTIME_CONSISTENCY_MODEL.md` — canonical transaction, event, outbox, and projection consistency model.
- `../docs/23_CORESDK_OPERATION_FLOW_DESIGN.md` — existing Action registration, CoreSDK handoff, trusted identity, idempotency, and transaction design.
- `specs/chore-postgres-drizzle-schema-foundation.md` — completed prerequisite Core database package and schema foundation.
- `package.json` — root database tests and final validation aggregation.
- `pnpm-workspace.yaml` — pinned Effect cohort and dependency policy.
- `packages/core-runtime/package.json` — Core runtime exports, dependencies, and focused test commands.
- `packages/core-runtime/src/db/client.ts` — Effect-managed typed Drizzle database service.
- `packages/core-runtime/src/db/types.ts` — database and transaction executor types; the handler-facing type must not expose transaction ownership.
- `packages/core-runtime/src/db/schema.ts` — Action Invocation, audit, Data Access, Domain Event, and Outbox persistence contracts.
- `packages/core-runtime/src/index.ts` — narrow public Core runtime exports.
- `packages/core-runtime/tests/unit/schema-contract.test.ts` — existing Action lifecycle schema protection.
- `packages/core-runtime/drizzle/` — generated Core migration history when the Action schema needs adjustment.
- `scripts/validate-ultramodern-workspace.mts` — generated workspace and package contract validation.

### New Files

- `packages/core-runtime/src/actions/definition.ts` — generic Action descriptor, handler, and registration contracts backed by Effect Schema values.
- `packages/core-runtime/src/actions/context.ts` — trusted principal, transport metadata, and handler execution context contracts.
- `packages/core-runtime/src/actions/events.ts` — typed Domain Event, Data Access Event, Outbox Message, and execution-local Domain Event reference contracts.
- `packages/core-runtime/src/actions/errors.ts` — tagged transport-neutral Core Action errors, including validation, idempotency, persistence, and indeterminate commit errors.
- `packages/core-runtime/src/actions/collector.ts` — per-execution append-only collectors and the enforced Domain Event-to-Outbox relationship.
- `packages/core-runtime/src/actions/repository.ts` — typed Drizzle persistence for invocation coordination and transactional evidence flushing.
- `packages/core-runtime/src/actions/runtime.ts` — Effect service that owns Action decoding, idempotency, locking, handler execution, transaction, commit resolution, and typed outcomes.
- `packages/core-runtime/tests/unit/action-definition.test.ts` — descriptor, payload decoding, and principal/payload separation tests.
- `packages/core-runtime/tests/unit/action-collector.test.ts` — Domain Event, Outbox Message, and Data Access collector invariant tests.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — focused orchestration and typed failure tests with controlled database collaborators.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — PostgreSQL proof of atomic success, rollback, idempotent retry, concurrency, and uncertain-commit resolution.

## Implementation Plan

### Phase 1: Foundation

Finish and validate the Core PostgreSQL/Drizzle foundation, then align
`ACTIONS.md` and the Core schema with the agreed lifecycle. Define the Action
descriptor, registration, trusted principal context, transport metadata,
transport-neutral errors, and append-only event collector contracts. Keep
payload identity-free and use `Schema.Void` for Actions without a business
payload.

Ensure the database can allocate ordered Domain Event sequence values safely
under concurrent transactions without application-side `max + 1` logic.
Serialize allocation and commit order for each tenant through the existing
tenant row.
Generated migrations remain Core-only. Preserve the existing invocation row as
the idempotency anchor: create it before the business transaction, allow
controlled lifecycle updates, and leave it open after a definite failure.

### Phase 2: Core Implementation

Implement the controlled collectors, typed Drizzle repositories, and Effect
Action runtime. The runtime validates payloads, creates or finds invocations,
checks request hashes, runs the deferred gate boundaries before the business
transaction, transitions an accepted invocation to `running`, and serializes
private handler execution inside a Core-owned transaction.

Persist only successful execution evidence. Flush all recorded Data Access
Events, Domain Events, and Domain Event-linked Outbox Messages before updating
the invocation to `succeeded`; any failure rolls the whole transaction back.
Preserve declared domain errors in the Effect error channel and map database or
runtime failures to safe Core errors without attaching HTTP statuses.

### Phase 3: Integration

Export the Action registration and runtime surface narrowly from
`@app/core-runtime` so Shell BFFs and server-side MicroVertical adapters can
submit registrations without exposing private handlers to browsers or other
verticals. Do not add a generic action-key/unknown-payload HTTP endpoint.
Generated per-Action BFF endpoints will reuse each descriptor's schemas and
perform HTTP mapping in later feature work.

Prove the complete behavior with test-local Shell/Core and MicroVertical-shaped
registrations. The same Core runtime contract must execute both without the
Shell importing a deployed MicroVertical implementation across a network seam.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Complete the database-foundation prerequisite

- [x] Finish `specs/chore-postgres-drizzle-schema-foundation.md` or rebase this work onto its completed `@app/core-runtime` package, preserving all pre-existing work and generated Core-only migration history.
- [x] Reinspect `packages/core-runtime/src/db/schema.ts`, database exports, package scripts, and worktree state before implementation because the prerequisite is currently in progress.
- [x] Do not run `scaffold:action`: this feature creates runtime infrastructure and test-local fakes, not a production Action descriptor or handler.

### 2. Align the authoritative Action lifecycle

- [x] Update `docs/architecture/ACTIONS.md` to distinguish an Action command/intent from a Domain Event business fact.
- [x] Document that the invocation is inserted before the business transaction; payload validation still occurs before invocation creation.
- [x] Document that the successful result audit record, successful Data Access Events, Domain Events, Outbox Messages, business writes, and invocation `succeeded` update are atomic.
- [x] Document that a definite rollback persists none of those transactional records, exposes no read result, returns a typed Effect error, and intentionally leaves the invocation open with no `completed_at`.
- [x] Document that open-invocation finalization and permanent failure evidence are deferred, while uncertain commit lookup is part of this feature.
- [x] Document that permissions and policies are deliberately skipped in this increment; retain explicit runtime stage boundaries so later work can add them before handler execution.

### 3. Reconcile the Core persistence contract

- [x] Adjust `packages/core-runtime/src/db/schema.ts` only where required to support the agreed lifecycle, safe invocation locking, committed-success detection, and concurrency-safe Domain Event sequence allocation.
- [x] Keep the existing unique idempotency scope of tenant, Action key, principal, and idempotency key. Treat the request hash as an additional invariant: a reused key with a different hash always fails.
- [x] Ensure the successful invocation update is part of the business transaction, so `succeeded` is the durable commit marker and `running` with no completion remains the deliberate open state after rollback.
- [x] Use a database-generated monotonic Domain Event sequence or another transaction-safe database mechanism; never allocate it with an unlocked application-side `max + 1`.
- [x] Generate any schema change through `mise exec -- pnpm db:generate`, inspect the generated Core-only SQL, and extend `packages/core-runtime/tests/unit/schema-contract.test.ts` with the lifecycle and sequence invariants.

### 4. Define typed Action registrations and execution inputs

- [x] Add `definition.ts` with an Effect Schema-backed Action descriptor, private generic Effect handler, and paired registration object. Prefer interfaces and immutable objects over inheritance.
- [x] Require stable Action key, owning module key, payload schema, result schema, declared domain-error schema, permitted Domain Event payload schemas, idempotency rule, audit profile, and a typed descriptor-owned Data Access evidence policy without embedding custom runtime control flow in the descriptor.
- [x] Represent no-payload Actions with `Schema.Void`; do not weaken payloads or results to `unknown` after decoding.
- [x] Add `context.ts` so `runAction` accepts trusted tenant/legal-entity/principal context separately from payload and transport metadata. The handler receives that trusted context but cannot source or override it from the payload.
- [x] Define a handler-facing transaction executor that supports typed Drizzle business queries but does not expose commit, rollback, or transaction creation.
- [x] Add `action-definition.test.ts` beside the contracts to prove typed payload decoding, no-payload Actions, typed results, principal separation, and rejection before invocation on structural decode failure.

### 5. Define typed, transport-neutral Action errors

- [x] Add `errors.ts` using tagged Effect errors for structural validation, trusted-context validation, idempotency-key reuse, request-hash conflict, invocation persistence, handler execution infrastructure failure, transaction failure, and indeterminate commit.
- [x] Preserve each Action handler's schema-declared tagged domain error type in the returned Effect error union rather than wrapping it in `unknown`, throwing it, or converting it to an HTTP response. Sanitize undeclared failure values as unexpected handler failures.
- [x] Give Core errors stable safe codes and useful messages, but no HTTP status. Document the expected upper-layer semantic mapping without implementing a BFF endpoint.
- [x] Add unit tests for exhaustive error tags, safe messages, declared handler rejection preservation, and unexpected defect sanitization.

### 6. Implement controlled execution collectors

- [x] Add `events.ts` with typed schemas/contracts for Data Access records, Domain Events, Outbox Messages, and an opaque execution-local Domain Event reference.
- [x] Add `collector.ts` with `recordDataAccess(event)`, `addDomainEvent(event)`, and `addOutboxMessage(domainEventRef, message)` methods.
- [x] Make `addDomainEvent` return the only reference accepted by `addOutboxMessage`. Reject a reference created by another execution or a reference not present in the current Domain Event collection.
- [x] Keep collector state private and append-only during one handler execution; expose no mutable event arrays to handlers.
- [x] Require handlers to record every business-data read whose result contributes to a successful response or write, including reads, lists, searches, exports, downloads, invariant checks, and repository lookups.
- [x] Add `action-collector.test.ts` beside the implementation to prove event ordering, multiple messages per Domain Event, an event without a message, rejection of orphan/foreign references, and no externally mutable arrays.

### 7. Implement invocation and evidence persistence

- [x] Add `repository.ts` using only the typed Core Drizzle schema and executor types.
- [x] Insert a new invocation in an independent write before opening the business transaction, or resolve the existing invocation for the same idempotency scope.
- [x] Compute a collision-safe deterministic request hash from the Action key, descriptor schema/version identity, trusted tenant/principal scope, target ResourceRef metadata, and normalized decoded payload. Never include correlation, trace, idempotency transport metadata, or unstable/locale-dependent JSON ordering.
- [x] Serialize competing attempts with a database row lock or equivalent transaction-safe mechanism. The handler must never run concurrently for the same invocation.
- [x] Apply idempotency behavior exactly: `succeeded` means return a typed already-committed error; open plus the same request hash may run again; any different request hash is a typed conflict. Do not persist or replay the original Action result.
- [x] Add typed repository operations to flush the success audit record, recorded Data Access Events, Domain Events, associated Outbox Messages, and invocation success update through the caller's transaction.
- [x] Batch where practical without weakening row-level schema validation or the Domain Event-to-Outbox association.

### 8. Implement the Effect Action runtime

- [x] Add `runtime.ts` as an Effect service that depends on `CoreDatabase` and the Action repository.
- [x] Decode payloads and validate trusted principal context before creating an invocation.
- [x] Create/resolve the invocation, run authentication/permission/policy stage boundaries before the business transaction, persist the accepted `received`-to-`running` transition independently, then open the single business transaction, lock/recheck the invocation immediately before the handler, and construct fresh collectors.
- [x] Execute the private handler with decoded payload, trusted principal, restricted transaction executor, and collector methods.
- [x] On handler success, validate the typed result and persist business changes plus all required success evidence and the `succeeded` invocation update before commit.
- [x] On handler/domain rejection, collector validation failure, persistence failure, or definite transaction failure, roll back and return the typed Effect error. Do not persist result, Data Access, Domain Event, Outbox, or terminal failure evidence, and do not complete the invocation.
- [x] When commit acknowledgement is uncertain, return `ActionCommitIndeterminate`. Expose an explicit trusted commit-resolution operation: `succeeded` proves commit and returns the already-committed error; an unlocked `received`, `running`, or `indeterminate` invocation is open; database unavailability remains indeterminate.
- [x] Log unexpected defects to operational telemetry with correlation context while keeping persisted Action evidence subject to the agreed transaction rules.
- [x] Add `action-runtime.test.ts` beside the runtime to prove stage order, fresh collectors, transaction ownership, typed result validation, domain-error preservation, rollback, and commit-resolution branches.

### 9. Prove PostgreSQL atomicity and concurrency

- [x] Add `tests/integration/action-runtime.test.ts` using test-local Action registrations and temporary test records in the existing Core schema; do not add a production Action or business schema.
- [x] Prove one successful Action atomically writes its test business mutation, result audit record, Data Access Event, Domain Event, linked Outbox Message, and `succeeded` invocation state.
- [x] Prove a handler domain rejection and a persistence failure roll back every transactional row, return typed errors, expose no read result, and leave the invocation open.
- [x] Prove an Outbox Message cannot commit without its registered Domain Event.
- [x] Prove concurrent requests with one idempotency key execute the handler at most once after one commits.
- [x] Prove a committed key returns the typed already-committed error, an open same-hash key may retry, and a different request hash conflicts.
- [x] Simulate lost commit acknowledgement and prove the explicit commit-resolution operation resolves committed versus open state without replaying a stored response and remains indeterminate while PostgreSQL is unavailable.
- [x] Keep integration fixtures isolated and delete only records created by the test through scoped teardown.

### 10. Publish the narrow server-side integration surface

- [x] Export Action descriptor, registration, trusted context, runtime service, handler context, collector methods, and public Core error types from `packages/core-runtime/src/index.ts` or explicit server-only package subpaths.
- [x] Keep private repository implementation, mutable collectors, database pool, and handler implementations unexported.
- [x] Ensure no Action server registration or handler can enter a browser Module Federation expose.
- [x] Add a contract test proving a Shell/Core-owned and a MicroVertical-shaped test registration use the same runtime interface without importing one another's private implementation.
- [x] Do not add a generic BFF endpoint. Record that a later generated production Action will add its own Effect HttpApi endpoint/client and exhaustively map Core/domain errors to declared HTTP schemas.

### 11. Integrate focused tests into repository validation

- [x] Update `packages/core-runtime/package.json` so its focused unit command includes the new Action unit tests and provide a deterministic integration-test command that uses the root `DATABASE_URL`.
- [x] Update the root package scripts only as necessary to expose the focused Action tests without making format, lint, or typecheck depend on a running database.
- [x] Extend `scripts/validate-ultramodern-workspace.mts` only when needed to recognize the new server-only Core exports and reject browser or cross-vertical private-handler exposure.
- [x] Keep the live PostgreSQL integration command separate from the offline `check` aggregate while ensuring all unit Action behavior runs in the normal quality gate.

### 12. Run all validation commands

- [x] From `app/`, execute every command under `Validation Commands` in order and resolve all failures without weakening architecture checks, schema contracts, or tests.

## Testing Strategy

### Unit Tests

Use Effect-aware tests or the existing Node test runner to verify descriptors,
Schema decoding, trusted-context separation, error unions, request hashing,
collector invariants, lifecycle ordering, transaction ownership, and every
typed failure branch. Runtime tests must use controlled collaborators so they
can assert exactly which persistence operations occur before, during, and after
the transaction.

### Integration Tests

Run the Core Action runtime against local PostgreSQL to prove actual transaction
atomicity, row locking, invocation persistence outside the transaction,
successful invocation update inside the transaction, Domain Event/Outbox
foreign keys, concurrent idempotency behavior, rollback behavior, and
commit-acknowledgement recovery. Use only Core-owned test records; no
MicroVertical schema or production business Action is required.

### Edge Cases

- A structurally invalid payload creates no invocation.
- A payload cannot supply or override tenant, legal entity, or principal.
- An Action with no payload decodes through `Schema.Void`.
- A required idempotency key is absent.
- The same key and payload arrive concurrently.
- The same key is retried after a committed transaction.
- The same open key is retried after a definite rollback.
- The same key is reused with a different payload or trusted scope.
- A handler returns an invalid result for its declared result schema.
- A handler returns a typed domain rejection after recording reads/events.
- A handler dies with an unexpected defect.
- A Data Access record, Domain Event, Outbox Message, result audit insert, or invocation success update fails.
- An Outbox Message references no Domain Event or a Domain Event from another execution.
- One Domain Event has zero, one, or multiple Outbox Messages.
- Commit succeeds but its acknowledgement is lost.
- The database remains unavailable while commit outcome is uncertain.

## Acceptance Criteria

- [x] Actions are immutable typed descriptors paired with private Effect handlers; no inheritance is required.
- [x] Trusted tenant/legal-entity/principal context is separate from and cannot be overridden by the Action payload.
- [x] Structurally invalid payloads create no invocation.
- [x] Every accepted Action creates or reuses an invocation before its business transaction and serializes concurrent execution by idempotency scope.
- [x] The handler receives a restricted transaction executor and cannot commit or roll back.
- [x] Successful business writes, result audit record, Data Access Events, Domain Events, Domain Event-linked Outbox Messages, and invocation `succeeded` update commit atomically.
- [x] A definite failure returns a typed Effect error, commits none of those records, exposes no read result, and leaves the invocation open.
- [x] Every Outbox Message is structurally and persistently linked to a Domain Event from the same execution.
- [x] A committed idempotency key fails without rerunning the handler or replaying the original result.
- [x] An open same-hash invocation may retry; a different request hash always conflicts.
- [x] Lost commit acknowledgement is resolved from committed invocation state when the database becomes available.
- [x] Domain Event sequence allocation cannot overtake commit order within one tenant under concurrent transactions.
- [x] Each Action declares its domain-error and Domain Event schemas; undeclared errors, events, payloads, and producer identities are rejected or sanitized.
- [x] Handler domain errors and Core runtime errors remain typed and transport-neutral; no handler constructs HTTP responses.
- [x] Permissions and policies are absent only as an explicit temporary stage, without being simulated or silently treated as allowed decisions.
- [x] No production Action, generic untyped Action endpoint, browser-visible handler, or cross-vertical private implementation import is introduced.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime db:test` — Run Core schema, configuration, and Action unit tests.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — Type-check the Core Action contracts, runtime, and tests with the repository TS7 toolchain.
- `mise exec -- pnpm db:migrate` — Apply the generated Core-only migration to local PostgreSQL.
- `mise exec -- pnpm db:verify` — Verify the live Core schema through typed Drizzle references.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — Prove Action atomicity, rollback, idempotency, and commit resolution against PostgreSQL after the implementation adds this focused script.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This feature was planned while the PostgreSQL/Drizzle foundation in `specs/chore-postgres-drizzle-schema-foundation.md` was in progress; implementation preserved that work and used its completed schema.
- Permissions and policies are intentionally deferred to the next steps. Authentication and trusted principal context are not deferred.
- Known failed invocations remain open in this increment. Their later terminalization, operational alerting, retention, and support workflow require separate product and architecture decisions.
- Data Access Events are persisted only for successfully committed Actions. Reads performed by a rolled-back Action produce no durable access record and no data result reaches the caller.
- A duplicate committed idempotency key returns a typed failure. OntOS does not persist or replay the original Action response.
- Reusing an idempotency key with a different request hash is treated as a conflict even when the earlier invocation remains open; permitting one intent key to represent different commands would make audit and concurrency behavior ambiguous.
- The invocation `succeeded` update is deliberately inside the successful business transaction so it is the durable commit marker used after a lost acknowledgement.
- The `indeterminate` condition is a typed runtime outcome while the database cannot confirm commit state. Once the database is reachable, `succeeded` proves commit and an unlocked open invocation proves that the previous transaction did not commit.
- Test-local Action registrations are infrastructure fixtures, not generated business Actions. The mandatory Codesmith generator remains required for the first production Shell/Core or MicroVertical Action.
- The shared Core runtime contract can be hosted in Shell/Core or used by a server-side MicroVertical adapter. Executable handler objects are local process values and are never transported over the network.

## Implementation Evidence

### Summary

- Restored the server-only typed Action descriptor, trusted execution context, evidence collectors, repository, Effect runtime, idempotency coordination, transaction ownership, and explicit commit-resolution surface.
- Restored the database-owned Domain Event sequence plus per-tenant commit-order lock, narrow Core exports, lifecycle guidance, validation wiring, and complete unit/integration coverage.

### Changed Files

24 files changed, 7,211 insertions, 63 deletions against the current `develop` merge base.

### Tests Written or Updated

- `packages/core-runtime/tests/unit/action-definition.test.ts` — proves descriptor immutability, descriptor-owned access-evidence policy, typed payload/result decoding, `Schema.Void`, and trusted-principal separation.
- `packages/core-runtime/tests/unit/action-errors.test.ts` — proves the exhaustive transport-neutral Core Action error surface and safe messages.
- `packages/core-runtime/tests/unit/action-collector.test.ts` — proves descriptor-owned evidence capture, mode-specific invariants, append-only evidence, declared event schemas, producer ownership, event/outbox linkage, foreign/orphan rejection, and immutable snapshots.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — proves stage order, fresh collectors, transaction ownership, typed domain failures, defect sanitization, rollback, idempotency, terminal states, commit resolution, and definite-versus-indeterminate commit failure classification.
- `packages/core-runtime/tests/unit/action-public-surface.test.ts` — proves collision-safe canonical hashing and the narrow server-only public surface.
- `packages/core-runtime/tests/unit/schema-contract.test.ts` — proves the database-owned Domain Event sequence and tenant-sequence uniqueness contract.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — proves atomic success, rollback at each individual success-evidence write, orphan rejection, idempotency/concurrency, tenant commit-order sequencing, and lost-acknowledgement resolution in PostgreSQL.

### Validation

- `mise exec -- pnpm db:generate` — passed; generated the reviewed Core-only `0001_cloudy_weapon_omega.sql` migration and synchronized snapshot.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed 26/26 Action unit tests.
- `mise exec -- pnpm db:test` — passed all 46 Core tests and the Better Auth integration test on the rebased branch.
- `mise exec -- pnpm db:migrate` — passed for both the Core and Better Auth migration ledgers and remained idempotent.
- `mise exec -- pnpm db:verify` with temporary local Better Auth validation values — passed with all 18 typed Core tables and all 4 typed Auth tables verified.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos_action_runtime_validation mise exec -- pnpm db:migrate` — passed against a temporary isolated database.
- `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos_action_runtime_validation mise exec -- pnpm db:verify` — passed with all 18 typed Core tables verified; the temporary database was then removed.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — passed 6/6 PostgreSQL integration tests.
- `mise exec -- pnpm check` — passed the complete offline quality gate.
- `mise exec -- pnpm build` — passed the production build, Module Federation type validation, and performance readiness checks.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `DATABASE.md`, `ULTRAMODERN.md`, the Core kernel, consistency model, and CoreSDK operation-flow guidance.
- Inspected `git status --short`, `git diff --check`, tracked and untracked diff statistics, the complete runtime/test source, generated migration, topology, package scripts, and public exports.
- Recovery review restored collision-safe transport-independent hashing, schema-declared domain errors/events, owning-module producer checks, principal-scoped commit resolution, open-state enforcement, defect sanitization, independent `received`-to-`running` transition, and the per-tenant sequence-allocation lock.
- Independent standards and spec reviews found and then verified fixes for descriptor-owned Data Access evidence policy, complete infrastructure-cause logging, realistic commit-acknowledgement failure classification, and per-stage PostgreSQL rollback coverage. Both review axes passed with no blocker.
- Final review found no browser exposure, cross-vertical private implementation import, generic Action endpoint, production Action, generator violation, unrelated application edit, or unexplained public API expansion. No screenshots apply because this feature has no user-facing surface.

### Deviations and Follow-ups

- After rebasing onto the completed Auth feature, the root database commands now validate Core and Auth together. The worktree's ignored `.env` predates Auth, so safe temporary local Auth values were supplied only to run the final verifier and tests; no tracked configuration or shared data was changed.
- Permissions, policies, terminal failed-invocation evidence, stored-artifact evidence binding, and generated per-Action BFF endpoints remain the explicit planned follow-up scope.
- The mandatory Action generator was intentionally not run because this feature adds runtime infrastructure and test-local registrations only.
