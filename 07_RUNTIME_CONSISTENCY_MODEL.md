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

The idempotency contract is end-to-end:

- UI creates a stable idempotency key when one user intent starts, such as opening a create modal or initializing a form instance. Double-clicks, request retries, and browser POST resubmits for that same intent must reuse the same key.
- Classic HTML forms should carry the key as a hidden input. Successful writes should prefer POST/Redirect/GET so refresh repeats a GET detail page rather than the write request.
- REST, MCP, SDK, import, and integration clients must send an `Idempotency-Key` for non-idempotent write actions. If the key is missing, the backend should reject the request, for example with `428 Precondition Required` or a domain error such as `idempotency_key_required`.
- SDKs and MCP adapters may generate a key automatically for one tool/action call, but retries of that same call must reuse it.
- External integrations should prefer deterministic keys from their source system, such as `booking:reservation:123:create`, `bank-file:abc:row:42`, or `mcp-run:<tool-run-id>`.
- Backend enforcement is authoritative. Disabled buttons are only UX. The runtime must use an atomic insert or equivalent lock around the unique idempotency scope.

Duplicate handling:

- Same key and same `request_hash` with `succeeded`: return the original result.
- Same key and same `request_hash` with `running`: return `202 pending` or wait briefly and then return the outcome.
- Same key and same `request_hash` with `failed`: return the original failure or apply an explicit retry policy.
- Same key and different `request_hash`: return `409 idempotency_conflict`.

Idempotency prevents duplicate execution of the same intent. It does not replace business uniqueness. Domain tables still need constraints for real-world duplicates, such as one invoice number per legal entity or one normalized channel name per workspace.

Suggested `status` values:

- `received`: invocation row exists, checks/execution not finished.
- `rejected`: authn/authz/policy/validation/idempotency conflict prevented execution.
- `running`: command handler is executing.
- `succeeded`: canonical transaction committed.
- `failed`: execution failed and the canonical transaction did not commit or committed a modeled failure state.
- `replayed`: duplicate idempotent request returned the earlier outcome.

Payload evidence belongs in `CORE_ACTION_PAYLOAD_RECORDS`, not directly in `CORE_ACTION_INVOCATIONS`. The payload table should support `request`, `response`, and `error` records with `evidence_capture_mode` values such as `metadata_only`, `hash_only`, `redacted_payload`, or `stored_artifact`. Raw sensitive payloads should not be stored by default. Large payloads or acceptance evidence can be encrypted in object storage and referenced by storage key with retention rules.

Read-side evidence is separate from write-side actions. `CORE_DATA_ACCESS_EVENTS` should record important reads, lists, searches, exports, and downloads: who accessed what, query/filter hash, result count, result hash or artifact reference, and timestamp. The default should not be “store every full response body forever”; high-volume and sensitive reads need sampling, redaction, retention, and explicit product/security reasons.

`evidence_capture_mode` is not supplied by frontend code, API clients, or ad hoc handler logic. It is set by the Core runtime from an access evidence policy declared on the public endpoint/action descriptor.

Evidence capture modes:

- `metadata_only`: record actor, time, endpoint/action, target/query metadata, and context, but no result hash or payload. Use for ordinary detail reads or sensitive reads where duplicated evidence would create more risk than value.
- `hash_only`: record a canonical query hash and/or result fingerprint without storing the result content. Use when tamper evidence matters but content storage is unnecessary or risky. A fingerprint hash is one-way evidence; it cannot reconstruct what the user saw without a matching manifest, redacted payload, or stored artifact.
- `redacted_payload`: store a redacted snapshot or summary in `evidence_payload_json`. The descriptor must name a `redaction_profile`; that column is nullable for every other mode.
- `stored_artifact`: store the exact output outside the database, encrypted, and reference it through `artifact_storage_key` or payload storage key. The descriptor must define artifact kind, retention, and encryption requirements.

System enforcement should be layered:

- Every public read/list/search/export/download endpoint must declare an access evidence policy. Missing policy should fail build or contract tests.
- The policy should be a typed discriminated union so `stored_artifact` cannot be declared without retention/encryption, and `redacted_payload` cannot be declared without a redaction profile.
- Public reads and exports should run through a runtime wrapper such as `withDataAccessEvidence(descriptor, handler)`. The wrapper writes `CORE_DATA_ACCESS_EVENTS`; handlers should not write arbitrary capture modes directly.
- Database constraints should enforce mode-specific invariants, such as `stored_artifact` requiring `artifact_storage_key`, `redacted_payload` requiring `redaction_profile` and redacted payload, non-redacted modes leaving `redaction_profile` null, and non-artifact modes leaving `artifact_storage_key` null.
- Changes to evidence policies for sensitive endpoints should require product/security review, because switching from `stored_artifact` to `metadata_only` changes business evidence and security posture.

For data access events, `serving_module_key` is the module that served the read/list/search/export/download surface, even when the returned data came from other modules. For example, `reporting.basic` may serve a report that includes billing and property resources.

`result_fingerprint_hash` should be understood narrowly: it is a SHA-256 fingerprint of a canonical result representation, not stored content. The representation must be identified by `result_fingerprint_schema`, such as `resource_refs_v1`. A typical `resource_refs_v1` fingerprint should use stable fields such as `module_key`, `resource_type`, `resource_id`, and optionally resource version or updated timestamp. It should not depend on mutable display names or labels. If the business needs to know exactly what was shown or exported later, the evidence mode must be `redacted_payload` or `stored_artifact`, not only `hash_only`.

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
