# Action Execution

## Core Rules

- Every state change in the system must be driven by an Action.
- An Action is a typed unit of code with a clear structure.
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

| Outcome                                                                                                                                                                      | Business transaction                                         | Required persistence                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rejected by authentication, permission checks, or policies                                                                                                                   | Do not open the business transaction or execute the handler. | In an independent evidence transaction, mark the Action Invocation Log as rejected and persist the required Audit Events and any Data Access Events.                    |
| Rejected by a typed domain rejection from the Action handler                                                                                                                 | Roll back the entire business transaction.                   | After rollback, use an independent evidence transaction to mark the Action Invocation Log as rejected and persist the required Audit Events and any Data Access Events. |
| Failed because authentication, permission, or policy evaluation failed operationally, or because the handler, required event persistence, or transaction definitively failed | Roll back the business transaction if one was opened.        | Use an independent evidence transaction to mark the Action Invocation Log as `failed` and persist the required Audit Events and any Data Access Events.                 |
| Indeterminate because the result of the business transaction commit is unknown                                                                                               | Do not assume that the transaction committed or rolled back. | Leave the Action Invocation Log non-terminal until reconciliation proves whether the canonical business records and Audit Events committed.                             |
| Successful                                                                                                                                                                   | Atomically commit all required business records and events.  | After commit, mark the Action Invocation Log as successful.                                                                                                             |

If an independent evidence transaction fails, retry it and raise an operational alert. A reconciler must scan non-terminal Action Invocation Logs. For attempts that never opened a business transaction, it may finalize an unrecoverable outcome as `failed` with an operational recovery code. When a commit result is indeterminate, reconcile it from canonical business records and committed Audit Events; mark the Action as successful only when the commit is proven and as `failed` only when rollback or non-commit is proven. If the outcome cannot be established, keep it indeterminate and raise a critical operational alert. Never roll back an already committed business transaction.

## Events and Transaction Boundaries

- Generate at least one Audit Event for every Action attempt that enters the lifecycle, including successful, failed, and rejected attempts. This mandatory event records the terminal outcome. Generate any additional audit checkpoints required by the Action’s evidence profile.
- Define each Action’s Domain Event requirements as part of the Action definition. An Action may instantiate zero or more Domain Events, and every instantiated Domain Event must be persisted.
- Generate a Data Access Event whenever Action processing reads business data.
- For a successful Action, persist the business updates, required Audit Events, instantiated Domain Events, Data Access Events, and Outbox Messages atomically in one business transaction.
- If any business update, Audit Event, Domain Event, Data Access Event, or Outbox Message cannot be persisted, roll back the entire business transaction and treat the Action as failed.
- Persist Audit Events and Data Access Events produced by rejected or failed attempts through the independent evidence transaction because those attempts do not commit a business transaction.
- The Action Invocation Log is never part of the business transaction.

## Outbox Messages

An Action handler may manually instantiate zero or more Outbox Messages and add them to the handler’s Outbox Message collection. The Action runtime persists every message in that collection as part of the business transaction.

## HTTP Error Mapping

Represent authentication, permission, policy, and domain rejections as typed Effect errors. When exposing an error over HTTP, use [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html) with the `application/problem+json` media type and apply the following [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) status mapping:

- `401 Unauthorized`: authentication credentials are missing, invalid, expired, revoked, or otherwise unusable. Include a `WWW-Authenticate` challenge.
- `403 Forbidden`: authentication succeeded, but SpiceDB or another access-control rule denied permission.
- `409 Conflict`: a business policy or typed domain rejection conflicts with the current mutable state of the target resource. Explain the conflict so that the caller can resolve it and retry.
- `422 Unprocessable Content`: the request media type and syntax are valid, but a business policy or typed domain rejection determines that the requested instruction is semantically ineligible. Use this only when the denial is neither an authorization failure nor a conflict with the resource’s current state.

Every Problem Details response must provide a stable URI reference as the machine-readable problem `type`, a human-readable `title` and `detail`, and the HTTP `status`. The `status` value must match the actual HTTP response status. Do not expose sensitive authorization or resource information in the response.
