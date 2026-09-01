# MVP2 CoreSDK Implementation Requirements

Date: 2026-06-15

This document updates the next MVP experiment after the runtime-attempt validation. `mvp2/` is a fresh implementation experiment, not a migration of the existing `mvp/` folder. It should use the latest available UltraModern.js scaffold so framework changes are tested directly.

## Purpose

MVP2 should prove that OntOS can keep MicroVerticals productive while forcing all sensitive backend work through a CoreSDK boundary that guarantees tenant/principal context, authorization, policy, transaction handling, audit/logging, domain events, outbox, idempotency, and read evidence.

The goal is a hybrid of the two architecture approaches:

- keep the operational context explicit and easy to pass through the runtime.
- avoid a mutable god object that every layer enriches arbitrarily.
- expose safe CoreSDK functions so MicroVertical code cannot accidentally bypass Core guarantees.

## Folder And Stack

- Create the experiment in top-level `mvp2/`.
- Base it on the latest UltraModern.js version available when implementation starts.
- Keep `mvp/` intact as the previous Day 1-4 proof unless explicitly retiring it.
- Record the exact scaffold command, UltraModern package versions, and framework behavior changes that affect the architecture.

## CoreSDK Boundary

CoreSDK is the required server-side entrypoint for all public write and read operations. Shell BFF handlers, MicroVertical server handlers, imports, integrations, SDKs, and later agents should call CoreSDK functions rather than directly composing DB transactions, authz checks, audit, events, or outbox.

CoreSDK must own:

- construction of `OperationalContext`.
- BetterAuth session/API-key to OntOS Principal resolution.
- tenant and legal-entity context validation.
- tenant module state checks.
- SpiceDB authorization calls.
- OntOS Policy Layer calls.
- idempotency key and request-hash handling.
- DB transaction creation and commit/rollback behavior.
- action invocation lifecycle rows.
- audit checkpoints and operational logs.
- domain event recording.
- outbox message recording.
- data-access evidence for reads/lists/searches/exports.

MicroVertical command handlers should receive only the safe context and services CoreSDK gives them, such as a transaction-scoped repository or unit-of-work service. They should not open their own top-level DB transaction for public operations and should not write Core runtime evidence directly.

## OperationalContext

`OperationalContext` is the server-side execution context CoreSDK builds for one operation. It may carry the resolved tenant, legal entity, principal, auth method, auth context reference, correlation id, idempotency key, request metadata, and trace/log references.

`OperationalContext` is the MVP2 implementation name for the internal runtime-attempt context described in earlier validation notes. It should not become a public domain model.

Rules:

- `OperationalContext` is internal runtime state, not a public API concept.
- It is not persisted as one generic JSON object.
- It is not a substitute for `CORE_ACTION_INVOCATIONS`, `CORE_AUDIT_EVENTS`, `CORE_DATA_ACCESS_EVENTS`, `CORE_DOMAIN_EVENTS`, or `CORE_OUTBOX_MESSAGES`.
- Pipeline stages should return typed decisions/results, not mutate arbitrary fields on the context.
- It may be passed into handlers and repositories only as a read-only context plus explicit transaction-scoped services.

## Write Path Requirement

A public write must run through a CoreSDK action function. The exact function names can change, but the shape must prove this behavior:

```text
UI/API/import/integration
  -> typed Shell or MicroVertical server surface
  -> CoreSDK action entrypoint
    -> build OperationalContext
    -> create/resolve ActionInvocation and idempotency state
    -> check module state
    -> check SpiceDB authorization
    -> check OntOS policy
    -> validate request
    -> run handler with transaction-scoped services
    -> commit domain data + action status + executed audit + domain event + outbox
  -> typed result
```

Denied attempts must write denial evidence without invoking the handler. Failed attempts must leave useful failure evidence even when canonical domain work rolls back. Idempotency replay/conflict must be resolved before handler execution.

## Read Path Requirement

Public reads, lists, searches, downloads, reports, and exports must run through a CoreSDK read/data-access function. The wrapper must enforce context, authorization, policy, and evidence rules before returning results.

The read path must prove:

- allowed reads can record metadata-only evidence.
- denied reads/searches record outcome evidence equivalent to audit checkpoint semantics.
- high-volume reads do not store raw payloads by default.
- stored artifacts or redacted payloads require an explicit evidence policy.

## Transaction And Logging Rules

CoreSDK must make transaction behavior visible in code and tests:

- successful write: one canonical Postgres transaction for domain rows, action status, executed audit, domain event, and outbox.
- denied write: evidence transaction, no handler execution.
- failed write: rollback partial canonical work and persist failure evidence.
- read: data-access evidence is written according to the endpoint/action evidence policy.

Logging should be structured and correlated with action invocation or data-access ids. Logs are not durable audit evidence by themselves; Core tables remain the source of durable evidence.

## BFF And MicroVertical Boundary

Shell/BFF and MicroVertical server surfaces are typed transport adapters inside the unified UltraModern Application Runtime. They should collect form/API input and call CoreSDK. They must not become a separate business layer and must not own transaction, audit, authorization, policy, domain-event, or outbox semantics.

Frontend code may create correlation ids and idempotency keys, but backend enforcement is authoritative.

## SpiceDB Consistency

Ordinary action authorization is a gate before handler execution. Role/access-management Actions that change SpiceDB relationships are special because SpiceDB writes are outside the Postgres transaction. MVP2 must document and test the chosen ordering, fail-closed behavior, compensation/retry path, and audit evidence for those Actions before treating access-management workflows as production-ready.

## MVP2 Acceptance

MVP2 is successful only if it proves:

1. A fresh `mvp2/` workspace runs on the latest UltraModern.js scaffold.
2. CoreSDK is the only server-side path used by demo public write/read operations.
3. `OperationalContext` is built by CoreSDK and remains internal runtime context.
4. A successful `property.registry.createUnit`-style Action commits domain row, action invocation status, executed audit, domain event, and outbox in the intended transaction boundary.
5. Authorization/policy/validation denials write evidence and do not invoke the handler.
6. A simulated handler failure leaves failure evidence and no partial canonical state.
7. Idempotency replay and conflict behavior are proven.
8. A public read/list path records allowed and denied data-access evidence.
9. Shell/BFF handlers contain no direct DB transaction, SpiceDB client, audit, domain-event, or outbox writes.
10. The implementation notes state what should be promoted back into production architecture and what should be rejected.
