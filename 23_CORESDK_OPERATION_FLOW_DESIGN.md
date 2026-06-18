# CoreSDK Operation Flow Design

Date: 2026-06-17

This note records the agreed CoreSDK operation-flow direction before implementation. It is a design note, not an ADR. The goal is to define how Effect BFF endpoints pass typed Actions into CoreSDK, how CoreSDK owns `OperationalContext`, and where transaction, idempotency, authorization, policy, and evidence responsibilities belong.

## Core Decision

`CoreSDK` is the server-side OntOS boundary for public writes and governed reads. BFF endpoints select typed Actions and pass operation input to CoreSDK. CoreSDK creates and enriches `OperationalContext`, runs the invariant operation flow, executes the private handler when allowed, persists evidence, and returns an operation result to the BFF.

The BFF must not create the final operational context, run authorization/policy checks itself, own transaction boundaries, write Core evidence rows, or call private action handlers directly.

## Action Ownership

The Action owns the input contract. The BFF exposes that contract. CoreSDK enforces the operation lifecycle.

Each server-side Action should be represented by an Action Registration:

- public Action Descriptor: action key, request schema, response schema, authorization requirement, policy requirements, audit profile, idempotency rule, and evidence requirements.
- private Action Handler: the function CoreSDK may call after required gates pass.

The BFF endpoint reuses the Action Descriptor request schema as its Effect endpoint payload schema. This means the frontend calls a typed Effect client method, the BFF receives a typed endpoint payload, and the BFF passes that typed payload with the Action Registration to CoreSDK.

The BFF should pass the server-only Action Registration, the typed payload, and transport metadata such as headers, correlation id, and idempotency key:

```text
BFF endpoint
  -> CoreSDK.runAction({
       registration,
       payload,
       transport
     })
```

## Trusted Identity

CoreSDK should resolve tenant, legal entity, and principal only from trusted auth/session/gateway context. It must not trust caller-supplied identity headers.

The current MVP2 direction remains valid:

- Shell BFF reads BetterAuth session state from request cookies/headers.
- Shell maps the BetterAuth user to OntOS tenant, legal entity, principal, and auth binding.
- Shell strips raw browser identity headers such as `x-tenant`, `x-user`, `x-legal-entity`, and `x-ontos-operation-context`.
- Shell signs a short-lived gateway token when forwarding to a MicroVertical BFF.
- CoreSDK verifies the gateway token internally and creates `OperationalContext`.

The next implementation step is to move gateway-token verification out of the MicroVertical BFF and into CoreSDK.

## OperationalContext Ownership

`OperationalContext` is internal runtime state owned by CoreSDK. It is not a public domain model and is not persisted as one generic JSON object.

CoreSDK returns operation results that carry the best available enriched context:

```text
OperationSucceeded
  context: OperationalContext
  response: typed action response

OperationRejected
  context: OperationalContext
  reason: typed rejection

OperationFailed
  context: OperationalContext
  reason: typed failure
```

Rejected and failed paths still return context because the BFF may need a consistent response envelope, support tooling may need correlation data, and CoreSDK evidence writing needs the same stage decisions.

## Typed Effect Errors

CoreSDK should use Effect's typed error channel for expected rejected or failed operation outcomes.

Examples:

- `OperationAuthRequired`
- `OperationContextInvalid`
- `OperationAuthorizationDenied`
- `OperationPolicyDenied`
- `OperationValidationFailed`
- `OperationIdempotencyConflict`
- `OperationDomainRejected`
- `OperationExecutionFailed`

A SpiceDB denial should become a typed `OperationAuthorizationDenied` error carrying the enriched context and the authorization decision. The HTTP adapter maps typed CoreSDK outcomes to HTTP statuses in one place. BFF endpoints should not inspect SpiceDB-specific details.

Suggested mappings:

- auth required or invalid context: `401`
- authorization denied: `403`
- policy denied: `409` or `422`, depending on policy kind
- validation failed: `422`
- idempotency conflict: `409`
- domain rejection from handler: usually `409` or `422`
- technical execution failure: `500` unless intentionally mapped

## Write Flow

The write flow should be invariant across Actions. Action descriptors provide declarative inputs to the flow; they do not define custom control flow.

Recommended flow:

```text
1. BFF receives typed Effect endpoint payload.
2. BFF calls CoreSDK with Action Registration, payload, and transport metadata.
3. CoreSDK verifies trusted identity from session/gateway context.
4. CoreSDK creates OperationalContext with action, transport, and identity.
5. CoreSDK obtains idempotency key from transport metadata.
6. CoreSDK computes request_hash from action key, context, schema/version, target, and normalized typed payload.
7. CoreSDK creates or locks core.action_invocations by idempotency scope.
8. CoreSDK returns replay/conflict immediately when idempotency requires it.
9. CoreSDK writes audit checkpoint action.received.
10. CoreSDK checks SpiceDB authorization.
11. CoreSDK checks OntOS policy.
12. CoreSDK records or confirms validation against the Action request schema.
13. CoreSDK starts the Core-owned Drizzle transaction for execution.
14. CoreSDK invokes the private handler with typed input and transaction-scoped services.
15. Handler writes domain data through transaction-scoped services.
16. CoreSDK writes final action status, audit checkpoint, domain events, and outbox messages.
17. CoreSDK commits the transaction.
18. CoreSDK returns OperationSucceeded with enriched OperationalContext and typed response.
```

This order may be adjusted during implementation if idempotency replay needs to avoid writing duplicate audit checkpoints. The invariant is that no handler executes before trusted identity, idempotency handling, authorization, policy, and validation have passed.

## Audit Checkpoints

`action.received` is a row in `core.audit_events`, not a separate table.

Conceptual checkpoint:

```text
event_type = action.received
outcome = succeeded
outcome_stage = system
outcome_code = action_received
action_invocation_id = ...
audit_profile = descriptor.auditProfile
```

Subsequent checkpoint rows use the same table for authorization, policy, validation, execution success, execution rejection, or execution failure.

## Idempotency

The UI creates an idempotency key for one user intent. For example, opening a create form creates a key, and double-clicks, retries, or resubmits for that same intent reuse the same key. A new user intent gets a new key.

The BFF forwards the idempotency key as transport metadata. Prefer an `Idempotency-Key` header for writes so the key does not pollute every Action's business input schema.

CoreSDK enforces idempotency:

- require a key when the Action descriptor says it is required.
- compute `request_hash`.
- create or lock `core.action_invocations` under `tenant_id + action_key + principal_id + idempotency_key`.
- return replay/pending/previous rejection when the same key and same request hash already exist.
- reject with idempotency conflict when the same key appears with a different request hash.

## Transaction Boundary

CoreSDK owns transaction start, commit, and rollback. The Action Handler must never commit or rollback directly.

The handler receives typed input and transaction-scoped capabilities:

```text
handler(input, {
  context,
  tx,
  repositories,
  emitDomainEvent,
  enqueueOutbox
})
```

`tx` or repository services must be scoped to the Core-owned transaction and should not expose commit/rollback to the handler.

Successful execution commits domain rows, final action state, audit checkpoint, domain events, and outbox messages together.

If the handler hits a business rule that should cancel the operation, it fails with a typed domain rejection. CoreSDK rolls back the transaction, writes rejection/failure evidence outside the rolled-back domain transaction as needed, and returns a typed CoreSDK rejection/failure.

Use current `core.audit_events.outcome_stage = execution` for handler/domain rejections because the schema currently supports `system`, `authn`, `authz`, `policy`, `validation`, and `execution`.

## Evidence Tables

For write Actions:

- `core.action_invocations` is the lifecycle envelope for the attempt.
- `core.audit_events` records checkpoints such as received, authz checked, policy checked, validation checked, executed, rejected, or failed.
- `core.domain_events` records committed business facts after a successful domain state change.
- `core.outbox_messages` records side effects derived from committed domain events.

`core.data_access_events` is mainly for reads, lists, searches, exports, and downloads. A write Action should not normally create a data-access event unless it performs a governed read/export as part of the operation.

`core.evidence_references` is for durable artifact evidence such as exports, generated documents, signed documents, compliance bundles, or explicit action snapshots. It should not become a generic raw payload store.

## Immediate Implementation Direction

The first implementation should build only the CoreSDK handoff mechanism:

- BFF passes Action Registration, typed payload, and transport metadata to CoreSDK.
- CoreSDK verifies trusted gateway/session context internally.
- CoreSDK creates and returns enriched `OperationalContext`.
- CoreSDK returns typed `OperationSucceeded`, `OperationRejected`, or `OperationFailed` shapes.
- No SpiceDB, policy, DB evidence writes, or handler execution changes are required in the first step unless added deliberately afterward.

After that, add CoreSDK stages one by one: idempotency/action invocation, `action.received` audit, SpiceDB authorization, policy, validation checkpoint, transaction-owned handler execution, domain events, and outbox.
