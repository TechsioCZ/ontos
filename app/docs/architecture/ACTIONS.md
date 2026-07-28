# Action Execution

This document defines state-changing Action execution. MicroVertical deployment and communication are defined in [MicroVertical Architecture](./MICROVERTICALS.md); public failure contracts are defined in [Effect Error and HTTP Contracts](./ERRORS.md).

## Core Rules

- Every state change in the system must be driven by an Action.
- An Action is a typed Effect program with a declared input, success value, expected error channel, and required dependencies.
- Generate Actions, Permissions, Policies, and Outbox Messages with their respective Codesmith generators.

## Invocation Lifecycle

Process every Action request in this order:

1. Decode the request and validate its structural input schema. A decoding or structural validation failure does not create an Action Invocation Log and does not enter the Action lifecycle. Evaluate pre-handler business eligibility later through policies. The Action handler remains responsible for domain invariants and may return a typed domain rejection.
2. Write the Action Invocation Log after structural validation and before authentication. Persist this record outside the business transaction so that it survives rejection, failure, and transaction rollback. The record must support attempts without an authenticated principal and retain the available anonymous session and transport correlation. If the initial record cannot be persisted, stop processing and return an internal failure.
3. Authenticate the request.
4. Check permissions in SpiceDB.
5. Evaluate the applicable global and MicroVertical-specific policies.
6. Execute the Action handler only after authentication, permission checks, and policy checks pass.

## Outcomes

Handle each possible outcome as follows:

### Rejected before the handler

Authentication, permission checks, or policies reject the request.

- **Business transaction:** Do not open it or execute the handler.
- **Required persistence:** In an independent evidence transaction, mark the Action Invocation Log as rejected and persist the required Audit Events and any Data Access Events.

### Rejected by the handler

The Action handler returns a typed domain rejection.

- **Business transaction:** Roll back the entire transaction.
- **Required persistence:** After rollback, use an independent evidence transaction to mark the Action Invocation Log as rejected and persist the required Audit Events and any Data Access Events.

### Failed

Authentication, permission, or policy evaluation fails operationally; or the handler, required event persistence, or transaction definitively fails.

- **Business transaction:** Roll it back if one was opened.
- **Required persistence:** In an independent evidence transaction, mark the Action Invocation Log as `failed` and persist the required Audit Events and any Data Access Events.

### Indeterminate

The result of the business transaction commit is unknown.

- **Business transaction:** Do not assume that it committed or rolled back.
- **Required persistence:** Leave the Action Invocation Log non-terminal until reconciliation proves whether the canonical business records and Audit Events committed.

### Successful

- **Business transaction:** Atomically commit all required business records and events.
- **Required persistence:** After commit, mark the Action Invocation Log as successful.

### Reconciliation

If an independent evidence transaction fails, retry it and raise an operational alert. A reconciler must scan non-terminal Action Invocation Logs. For attempts that never opened a business transaction, it may finalize an unrecoverable outcome as `failed` with an operational recovery code. When a commit result is indeterminate, reconcile it from canonical business records and committed Audit Events; mark the Action as successful only when the commit is proven and as `failed` only when rollback or non-commit is proven. If the outcome cannot be established, keep it indeterminate and raise a critical operational alert. Never roll back an already committed business transaction.

## Events and Transactions

- Generate at least one Audit Event for every Action attempt that enters the lifecycle, including successful, failed, and rejected attempts. This mandatory event records the terminal outcome. Generate any additional audit checkpoints required by the Action’s evidence profile.
- Define each Action’s Domain Event requirements as part of the Action definition. An Action may instantiate zero or more Domain Events, and every instantiated Domain Event must be persisted.
- Generate a Data Access Event whenever Action processing reads business data.
- For a successful Action, persist the business updates, required Audit Events, instantiated Domain Events, Data Access Events, and Outbox Messages atomically in one business transaction.
- If any business update, Audit Event, Domain Event, Data Access Event, or Outbox Message cannot be persisted, roll back the entire business transaction and treat the Action as failed.
- Persist Audit Events and Data Access Events produced by rejected or failed attempts through the independent evidence transaction because those attempts do not commit a business transaction.
- The Action Invocation Log is never part of the business transaction.

## Outbox Messages

An Action handler may manually instantiate zero or more Outbox Messages and add them to the handler’s Outbox Message collection. The Action runtime persists every message in that collection as part of the business transaction.

## Public Action Failures

Authentication, permission, policy, and domain rejections remain typed Effect errors throughout the Action lifecycle. At the Backend for Frontend (BFF) endpoint, map them exhaustively to the declared public error schemas and status codes in [Effect Error and HTTP Contracts](./ERRORS.md). Do not let an Action error escape as an exception, an untyped rejected Promise, or an ad hoc HTTP response.
