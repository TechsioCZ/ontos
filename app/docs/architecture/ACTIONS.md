# Action Execution

This document defines state-changing Action execution. MicroVertical deployment and communication are defined in [MicroVertical Architecture](./MICROVERTICALS.md); public failure contracts are defined in [Effect Error and HTTP Contracts](./ERRORS.md).

## Core Rules

- Every state change in the system must be driven by an Action.
- An Action is a typed command or intent with a declared payload, success value, expected error channel, and required dependencies. Its private handler is an Effect program.
- Every Action descriptor declares an explicit readonly array of immutable Policy object references. A global Shell/Core Policy may be referenced by any Action; an executable MicroVertical Policy may be referenced only by an Action with the same owning module key. Raw Policy keys, registries, and cross-owner Policy imports are forbidden.
- A Domain Event is a past-tense business fact produced by a successfully committed Action. Domain Events describe what happened; they do not initiate hidden synchronous business state changes.
- Generate Actions, Permissions, Policies, and Outbox Messages with their respective Codesmith generators.

Better Auth credential and session lifecycle operations—sign-in, sign-out or revocation, refresh,
and active tenant selection—are Shell-owned authentication mechanics, not canonical business-state
mutations. They use the strict typed Auth BFF and must not update Core business tables or emit
Domain Events. Core Principal Auth Bindings remain the tenant-access authority, and a selected
tenant ID stored on the Auth session grants no permission. Any later canonical Core or
MicroVertical state change still requires an Action; authentication mechanics do not provide a
bypass.

## Invocation Lifecycle

Process every Action request in this order:

1. Decode the request and validate its structural input schema. A decoding or structural validation failure does not create an Action Invocation Log and does not enter the Action lifecycle. The Action handler remains responsible for domain invariants and may return a typed domain rejection.
2. Resolve and validate trusted tenant, legal-entity, principal, authentication, and correlation context separately from the Action payload. A payload must never supply or override trusted identity. A Shell-user call crossing a MicroVertical seam obtains this context only after the receiving BFF verifies the Shell-issued EdDSA assertion for its exact topology app ID. The assertion proves authentication and context only; it grants no Action permission and carries no Policy decision or business payload.
3. Insert or resolve the Action Invocation Log outside and before the business transaction. The invocation is the durable idempotency anchor. If it cannot be persisted, stop processing with a typed infrastructure failure.
4. Reject request-hash conflicts and treat an already `succeeded` invocation as committed without rerunning the handler or replaying a stored result.
5. Enter the authentication boundary and check the Action permission through Core's SpiceDB service. The descriptor `actionKey` is losslessly encoded as `ak_` plus unpadded base64url for SpiceDB's restricted object-id alphabet; the trusted `principalId` remains the exact subject identifier.
6. If permission allows, evaluate every referenced Policy sequentially and fail-fast in descriptor order. Policy input contains only the decoded payload, trusted principal context, sanitized transport/target metadata, and Action identity.
7. If permission or a Policy denies, atomically finalize the still-`received` invocation as `rejected` outside the business transaction and return the corresponding typed denial. A permission-check or Policy-evaluation failure returns a sanitized typed error and leaves the invocation open for retry.
8. Only after permission and all Policies allow, persist the accepted invocation transition from `received` to `running` independently so a definite business rollback leaves it open.
9. Open the Core-owned business transaction, lock and recheck the invocation immediately before handler execution, then execute the private Action handler with a restricted transaction executor. Competing requests may repeat read-only gates, but their handlers must never run concurrently.

The first Shell/Core runtime receives an already trusted principal context. Permission and Policy evaluation are both enforced before the invocation becomes `running`, the business transaction opens, or the handler and collector are created. An Action is unconfigured in SpiceDB only when a fully consistent check of its self-referential restriction marker returns a definite negative decision; that compatibility case is allowed. A marked Action requires a definite positive `execute` decision for the trusted principal. Missing configuration, timeout, unavailability, authentication/schema failure, conditional decisions, and every other indeterminate result fail closed while leaving the invocation open in `received`.

## Outcomes

Handle each possible outcome as follows:

### Definite rejection or failure

The Action handler returns a typed domain rejection, a collector invariant fails, required persistence fails, an unexpected handler defect is sanitized, or the transaction definitely rolls back.

- **Business transaction:** Roll back the entire transaction.
- **Required persistence:** Persist no business write, result Audit Event, Data Access Event, Domain Event, Outbox Message, terminal failure evidence, or `completed_at` value from the rolled-back attempt.
- **Invocation state:** Intentionally leave the independently persisted invocation open. Open-invocation finalization, permanent failure evidence, retention, and support workflow are deferred.
- **Response:** Return a declared typed Effect error and expose no read or handler result to the caller.

Permission and Policy denials are the deliberate pre-execution exceptions to this general rollback rule. Because no business transaction or handler has started, Core opens a separate transaction and locks and rechecks the invocation. A permission denial writes one terminal `action.rejected` Audit Event with `outcome = denied`, `outcome_stage = authz`, and `outcome_code = spicedb_permission_denied`. A Policy denial writes a denied `action.policy_checked` Audit Event plus terminal `action.rejected` Audit Event at the `policy` stage. Both paths mark the invocation `rejected` with `completed_at`, serialize concurrent attempts, and retain only small redacted identity metadata. If either evidence transaction fails, all rejection writes roll back, the invocation remains open, and Core returns a typed persistence failure rather than claiming a durable rejection.

### Indeterminate

The database did not acknowledge whether the business transaction committed.

- **Business transaction:** Do not assume that it committed or rolled back.
- **Required persistence:** Return a typed indeterminate outcome while the database is unavailable. Once lookup is possible, `succeeded` proves commit; an unlocked open invocation with the same request hash permits retry.

### Successful

- **Business transaction:** Atomically commit one allowed `action.policy_checked` Audit Event per evaluated Policy, the handler's business writes, successful result Audit Event, successful Data Access Events, Domain Events, Domain Event-linked Outbox Messages, and the invocation `succeeded` update with `completed_at`. An Action with `policies: []` retains the previous success evidence shape.
- **Required persistence:** The `succeeded` invocation update is the durable commit marker. It is not a post-commit write.

### Reconciliation

This increment resolves uncertain commits through an explicit server-side commit-resolution operation. It accepts the invocation identifier and trusted principal context, waits for any transaction lock to clear, and reports `succeeded` as already committed or an unlocked `received`, `running`, or `indeterminate` invocation as open. Database unavailability remains `ActionCommitIndeterminate`. General scanning, alerting, permanent failure finalization, and retention of open invocations remain deferred. Never roll back an already committed business transaction.

## Events and Transactions

- Persist a successful result Audit Event for every committed Action. Generate any additional successful audit checkpoints required by the Action's evidence profile.
- Define every expected domain failure, each permitted Domain Event type and payload schema, and the Data Access evidence policy as part of the Action descriptor. The policy—not handler input—selects `metadata_only`, `hash_only`, or `redacted_payload`; this runtime does not accept `stored_artifact` until Core can enforce its media, retention, classification, and encryption contract. An Action may instantiate zero or more declared Domain Events, and every instantiated Domain Event must be persisted. Core rejects undeclared error values, undeclared event types, invalid event payloads, and any event whose producer differs from the descriptor's owning module.
- Build idempotency request hashes from canonical decoded business payload, Action/schema identity, trusted tenant/principal scope, and target ResourceRef metadata only. Correlation, tracing, authentication transport, and idempotency metadata are not part of the business request hash.
- Record a Data Access Event whenever Action processing reads business data whose result contributes to a successful response or write, including reads, lists, searches, exports, downloads, invariant checks, and repository lookups.
- For a successful Action, persist the business updates, successful Audit Events, instantiated Domain Events, Data Access Events, Domain Event-linked Outbox Messages, and invocation success marker atomically in one business transaction.
- If any business update, Audit Event, Domain Event, Data Access Event, or Outbox Message cannot be persisted, roll back the entire business transaction and treat the Action as failed.
- Do not persist Audit Events or Data Access Events collected by a rejected or failed handler attempt. The only pre-execution exceptions are the small, Core-owned permission and Policy denial evidence described above.
- The Action Invocation Log is inserted independently before the business transaction, but its successful status update is part of the business transaction.
- Before allocating Domain Event sequence numbers, lock the owning tenant row for the remainder of the transaction. This serializes sequence allocation with commit order for one tenant so checkpoint consumers cannot skip an event that commits late.

## Outbox Messages

An Action handler may instantiate zero or more Domain Events. Adding a Domain Event returns an execution-local opaque reference. An Outbox Message may be added only with a Domain Event reference registered by that same execution. The Action runtime persists each message with a database foreign key to its Domain Event in the same business transaction. Orphan references and references from another execution are rejected before persistence.

Cross-MicroVertical consumers use only the message producer's published schema-only contract and the post-commit lifecycle defined by [Outbox Worker Architecture](./OUTBOX_WORKERS.md). Worker execution never joins or extends the originating Action transaction.

## Public Action Failures

Authentication, permission, policy, and domain rejections remain typed Effect errors throughout the Action lifecycle. At the Backend for Frontend (BFF) endpoint, map them exhaustively to the declared public error schemas and status codes in [Effect Error and HTTP Contracts](./ERRORS.md). Do not let an Action error escape as an exception, an untyped rejected Promise, or an ad hoc HTTP response.

Authentication assertion failures occur before the Action lifecycle and must not create an Action
Invocation Log or reach an Action handler. An endpoint maps missing, malformed, tampered, expired,
or otherwise unusable assertions to its declared `401` Problem Details response with a
`WWW-Authenticate: Bearer` challenge. Public-JWKS or verification configuration unavailability maps
to a declared retryable `503`. These endpoint-specific mappings do not replace the separate Core
permission and Policy mappings and do not justify a generic Action HTTP endpoint.
