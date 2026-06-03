# Runtime and consistency model

OntOS should use an action-driven core with evented side effects. This avoids the main failure mode of naive event-driven ERP architecture: business state changing unpredictably through subscriber chains.

## Write flow

A user, API consumer, import, integration, or later agent invokes a registered Action. The runtime resolves the authenticated principal, tenant context, legal-entity context, module state, authorization, and policy checks before running the Command Handler.

The Command Handler writes canonical state to Postgres in a transaction. When the action changes business state, the same transaction should record the relevant audit event, domain event, and outbox message. After commit, workers process outbox messages and update derived read models or external outputs.

## Why actions before events

A business action is intentional and authorized. A domain event is a record that something happened. If events become the primary mechanism for state changes, the architecture becomes difficult to reason about: subscriber order matters, side effects become hidden, and performance degrades through synchronous fan-out.

For V0, business correctness should live in actions and command handlers. Events are used for history and side effects.

## Domain events

Domain events should be named as past-tense business facts. Examples: lease contract created, reservation cancelled, invoice issued, payment matched, document attached, entity linked, module suspended. They should have small, versioned payloads and reference entities rather than embedding full object snapshots by default.

Domain events are useful for timeline, audit-adjacent explanations, projection triggers, reporting refreshes, and future analytics. They are not a substitute for domain tables.

## Audit events

Audit events capture evidence: actor, principal kind, tenant, legal entity, action, target resource, permission decision, policy decision, before/after summary where needed, request metadata, and timestamp. Audit must be reliable and queryable because both the business and delivery process require traceability.

Audit events are not workflow triggers. They are evidence records.

## Action invocations and payload evidence

`CORE_ACTION_INVOCATIONS` is the lifecycle envelope for a write-side Action attempt. It should answer: who invoked which action, in which tenant/legal-entity context, against which target, through which authentication path, with what idempotency key, and how execution ended.

`auth_method` records the authentication path used at runtime: `session`, `api_key`, `system`, or `support_impersonation`. This is intentionally separate from `principal_id`, because the same principal may act through an interactive session, an API key, or a system job. It is also separate from authorization; SpiceDB still answers permission questions.

`auth_context_ref` is an optional non-secret runtime reference for investigation, such as a BetterAuth session id, BetterAuth API key id, support impersonation session id, or worker run id. It must not contain raw API keys, session tokens, passwords, or secrets.

`idempotency_key` is an optional client-provided retry key. For non-idempotent writes, the runtime should enforce uniqueness for a scope such as `tenant_id + action_key + principal_id + idempotency_key`. If the same key is submitted again with the same request hash, the runtime can return the original result or mark the duplicate as `replayed`. If the same key is submitted with a different request hash, it should fail as an idempotency conflict.

`request_hash` is a SHA-256 hash of the canonical request envelope after normalization. It should include the action key, tenant/legal-entity context, target ResourceRef where present, schema version, and normalized request body. It is used for idempotency conflict detection, tamper evidence, and debugging without requiring raw payload storage in the main invocation row.

Suggested `status` values:

- `received`: invocation row exists, checks/execution not finished.
- `rejected`: authn/authz/policy/validation/idempotency conflict prevented execution.
- `running`: command handler is executing.
- `succeeded`: canonical transaction committed.
- `failed`: execution failed and the canonical transaction did not commit or committed a modeled failure state.
- `replayed`: duplicate idempotent request returned the earlier outcome.

Payload evidence belongs in `CORE_ACTION_PAYLOAD_RECORDS`, not directly in `CORE_ACTION_INVOCATIONS`. The payload table should support `request`, `response`, and `error` records with capture modes such as `hash_only`, `redacted_json`, `object_ref`, or `omitted`. Raw sensitive payloads should not be stored by default. Large payloads or acceptance evidence can be encrypted in object storage and referenced by storage key with retention rules.

Read-side evidence is separate from write-side actions. `CORE_DATA_ACCESS_EVENTS` should record important reads, lists, searches, exports, and downloads: who accessed what, query/filter hash, result count, result hash or artifact reference, and timestamp. The default should not be “store every full response body forever”; high-volume and sensitive reads need sampling, redaction, retention, and explicit product/security reasons.

## Outbox messages

Outbox messages are technical delivery records. They are written transactionally with canonical data so that side effects are not lost when a process crashes between database write and external notification.

Outbox workers handle Neo4j projection, search projection, reporting refresh, accounting export preparation, future notifications, and future integration events. Handlers must be idempotent, retryable, observable, and capable of dead-lettering.

## Synchronous vs asynchronous work

Synchronous action execution should include authentication, authorization, policy checks, validation, canonical Postgres writes, audit/domain/outbox recording, and small local derived values. It should not include external API calls, Neo4j writes, search indexing, report recomputation, email/SMS delivery, or heavy imports.

Asynchronous workers should handle all side effects that can be retried or rebuilt. The user-facing action should return once canonical state is committed.

## Consistency levels

Operational ERP state is strongly consistent inside Postgres transactions. Graph, search, reporting, and integration projections are eventually consistent. The UI must be honest about this when necessary. For example, a graph view can show projection freshness or lag if relevant.

The architecture must tolerate projection failures. A failed Neo4j projection should not invalidate a created invoice. A failed accounting export worker should leave an export batch in a failed state for retry, not roll back the original invoice unless that was explicitly modeled as a reversible business action.

## Performance guardrails

The first implementation should include guardrails rather than assuming performance will be fine. Useful early measurements include API p95/p99 latency, DB query count per request, slow queries, event loop delay, SpiceDB check latency, outbox lag, worker duration, Neo4j projection lag, and search latency.

The runtime should avoid unbounded relation expansion, unbounded synchronous subscribers, per-result authorization calls in large search result sets, large event payloads, and heavy work inside request handlers.
