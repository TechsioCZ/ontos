# Runtime and consistency model

OntOS should use an action-driven core with evented side effects. This avoids the main failure mode of naive event-driven ERP architecture: business state changing unpredictably through subscriber chains.

## Write flow

A user, API consumer, import, integration, or later agent invokes a registered Action. The runtime resolves the authenticated principal, tenant context, legal-entity context, module state, authorization, and policy checks before running the Command Handler.

The Command Handler writes canonical state to Postgres in a transaction. When the action changes business state, the same transaction should record the relevant audit event, domain event, and outbox message. After commit, workers process outbox messages and update derived read models or external outputs.

## Tenant module state changes

`CORE_TENANT_MODULE_STATE_CHANGES` is a history table for tenant-level module activation/suspension/read-only state changes.

`changed_by_principal_id` stores the effective actor. For ordinary admin changes, that is the admin principal. For support/admin impersonation, that is the impersonated principal because the action executes as that principal.

Do not duplicate `impersonated_by_principal_id` into this history table. User/support-driven state changes must have `action_invocation_id`; the joined `CORE_ACTION_INVOCATIONS` row is the source of truth for `auth_method`, `auth_context_ref`, `auth_binding_id`, and optional `impersonated_by_principal_id`. This keeps impersonation evidence in one action/audit envelope instead of copying it into every derived history table.

Suggested invariants:

- `change_source in ('user', 'support')` requires `action_invocation_id` and `changed_by_principal_id`.
- `change_source = 'support'` should point to an action invocation with `auth_method = 'support_impersonation'` or another explicit support auth method.
- `change_source = 'system'` may use a system/service principal or leave `changed_by_principal_id` null when the source is otherwise clear.
- When `action_invocation_id` is present, `changed_by_principal_id` should match the action invocation's effective `principal_id`.

## Why actions before events

A business action is intentional and authorized. A domain event is a record that something happened. If events become the primary mechanism for state changes, the architecture becomes difficult to reason about: subscriber order matters, side effects become hidden, and performance degrades through synchronous fan-out.

For V0, business correctness should live in actions and command handlers. Events are used for history and side effects.

## Domain events

Domain events should be named as past-tense business facts. Examples: lease contract created, reservation cancelled, invoice issued, payment matched, document attached, entity linked, module suspended. They should have small, versioned payloads and reference entities rather than embedding full object snapshots by default.

Domain events are useful for timeline, audit-adjacent explanations, projection triggers, reporting refreshes, and future analytics. They are not a substitute for domain tables.

`producer_module_key` is the module that emitted the event and owns the event contract. It answers "which module produced this fact for downstream consumers?"

`subject_module_key`, `subject_resource_type`, and `subject_resource_id` are the primary ResourceRef the event is about. In the common case, producer and subject module are the same. They can differ when a module emits an integration/workflow fact about a resource owned by another module, but that should be intentional and rare; canonical domain state should still be owned by the subject's module.

`tenant_sequence_no` is a monotonic ordering key for the tenant's domain-event stream. It should be unique within `tenant_id` and assigned transactionally with the event. It is not a business number, not gapless accounting numbering, and not a replacement for `occurred_at`; gaps are acceptable if transactions roll back or sequence allocation is skipped.

Workers that consume the domain-event stream should checkpoint by position, not by event id. `CORE_WORKER_CHECKPOINTS` stores one cursor per `tenant_id + consumer_name + stream_key`, with `last_tenant_sequence_no` as the last fully processed tenant event. A worker then reads `CORE_DOMAIN_EVENTS where tenant_id = ? and tenant_sequence_no > last_tenant_sequence_no order by tenant_sequence_no`.

This makes projection rebuilds, retries, and lag calculation straightforward. `domain_event_id` identifies one event, but it is not an ordering cursor.

## Audit events

Audit events capture evidence: actor, principal kind, tenant, legal entity, action, target resource, checkpoint outcome, outcome stage/code, small supporting facts, request metadata, and timestamp. Audit must be reliable and queryable because both the business and delivery process require traceability.

Audit events are not workflow triggers. They are evidence records.

The default V0 profile should emit multiple audit checkpoints for one action attempt. This preserves analysis value that cannot be reconstructed later: where actions are blocked, which policies create friction, which modules fail during execution, and which security gates are frequently denied.

Default `standard` checkpoint flow:

- `action.received`: the action request entered the Core runtime.
- `action.authn_resolved`: the runtime resolved the effective principal and authentication context.
- `action.authz_checked`: SpiceDB authorization was checked.
- `action.policy_checked`: module/core policy was checked.
- `action.validation_checked`: request/domain validation was checked.
- terminal event: one of `action.executed`, `action.rejected`, or `action.failed`.

`sensitive` audit profile may add extra domain/security checkpoints, such as support impersonation, role changes, module activation, destructive operations, accounting export, bulk download, or legally significant document operations.

`minimal` audit profile is an explicit exception for noisy internal/system jobs where full checkpoint audit would create low-value volume. It should not be the default for user-facing ERP actions.

`outcome` values have specific meanings:

- `allowed`: a gate stage allowed the action to continue.
- `denied`: a gate stage stopped the action before business execution.
- `succeeded`: a system/execution checkpoint completed successfully.
- `failed`: execution or system processing failed after the action had started.

`outcome_stage` identifies where the outcome came from: `system`, `authn`, `authz`, `policy`, `validation`, or `execution`.

`outcome_code` is the stable machine-readable reason, such as `action_received`, `principal_resolved`, `spicedb_permission_allowed`, `spicedb_permission_denied`, `invoice_already_exported`, `validation_passed`, `invalid_payload`, `invoice_issued`, or `numbering_series_exhausted`.

`evidence_json` contains small redacted supporting facts only. It should not duplicate `outcome`, `outcome_stage`, or `outcome_code`; those are the single source of truth for the result. It should not contain raw request payloads, raw response bodies, tokens, secrets, or full business object snapshots. Exact action request/response evidence belongs outside the baseline Core DB and should be referenced only by explicit evidence policy; read/export/download evidence belongs in `CORE_DATA_ACCESS_EVENTS`.

Do not add separate `authz_decision` or `policy_decision` columns. The normalized model is `outcome + outcome_stage + outcome_code + evidence_json`.

## Action invocations and trace correlation

`CORE_ACTION_INVOCATIONS` is the lifecycle envelope for a write-side Action attempt. It should answer: who invoked which action, in which tenant/legal-entity context, against which target, through which authentication path, with what idempotency key, and how execution ended.

`auth_method` records the authentication path used at runtime: `session`, `api_key`, `system`, or `support_impersonation`. This is intentionally separate from `principal_id`, because the same principal may act through an interactive session, an API key, or a system job. It is also separate from authorization; SpiceDB still answers permission questions.

`auth_context_ref` is an optional non-secret runtime reference for investigation, such as a BetterAuth session id, BetterAuth API key id, support impersonation session id, or worker run id. It must not contain raw API keys, session tokens, passwords, or secrets.

`trace_id` stores the OpenTelemetry trace id when the action runs inside an instrumented Effect/OpenTelemetry context. It is a join key into the observability backend, not durable business evidence.

`correlation_id` stores the application/request correlation id used across frontend, API, workers, logs, and support tooling. It may equal an inbound request id, generated UI intent id, import run id, or integration delivery id. It is useful when one user-visible operation spans multiple traces or background workers.

`idempotency_key` is an optional client-provided retry key. For non-idempotent writes, the runtime should enforce uniqueness for a scope such as `tenant_id + action_key + principal_id + idempotency_key`. If the same key is submitted again with the same request hash, the runtime can return the original result or mark the duplicate as `replayed`. If the same key is submitted with a different request hash, it should fail as an idempotency conflict.

`request_hash` is a SHA-256 hash of the canonical request envelope after normalization. It should include the action key, tenant/legal-entity context, target ResourceRef where present, schema version, and normalized request body. It is used for idempotency conflict detection, tamper evidence, and debugging without requiring raw payload storage in the main invocation row.

Core DB is not a generic payload store or observability backend. Postgres stores the action/audit spine and durable evidence references. `CORE_MEDIA_ASSETS` stores object-storage metadata for files/artifacts. Effect/OpenTelemetry stores technical request traces. Object storage/archive stores large or exact artifact bytes only when an explicit evidence policy requires them. The baseline Core schema must not store generic action request/response payloads.

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

Idempotency replay should normally return a stable resource reference or reconstruct the response from canonical state. If exact response replay is a legal/product requirement for a specific action, that is an explicit evidence policy exception and must use durable artifact/reference storage rather than generic payload rows in Postgres.

Suggested `status` values:

- `received`: invocation row exists, checks/execution not finished.
- `rejected`: authn/authz/policy/validation/idempotency conflict prevented execution.
- `running`: command handler is executing.
- `succeeded`: canonical transaction committed.
- `failed`: execution failed and the canonical transaction did not commit or committed a modeled failure state.
- `replayed`: duplicate idempotent request returned the earlier outcome.

If compliance needs exact action request, response, export, signed-document, import-file, or acceptance evidence, use `CORE_EVIDENCE_REFERENCES` deliberately. It should bind a core source row to a stored `CORE_MEDIA_ASSETS` artifact and should not store raw request/response bodies in Postgres.

## Evidence references

`CORE_EVIDENCE_REFERENCES` is the database table for the Evidence Registry. It answers: which stored artifact is audit/compliance evidence, which core event produced or justified it, which primary business subject it belongs to, which evidence and retention policy applies, and whether it is under legal hold or eligible for deletion.

The table should contain metadata only:

- `evidence_reference_id uuid`: primary key.
- `tenant_id uuid`: required tenant scope and partition/index key.
- `legal_entity_id uuid nullable`: optional legal-entity scope. Null means tenant-wide, cross-entity, or not legally entity-specific.
- `media_asset_id uuid`: required FK to `CORE_MEDIA_ASSETS`. The media asset row owns `storage_provider`, `storage_key`, optional `storage_object_version_ref`, filename metadata, `mime_type`, `byte_size`, and `content_sha256`.
- `source_kind text`: discriminator with values such as `action`, `audit`, `data_access`, or `domain_event`.
- `action_invocation_id uuid nullable`, `audit_event_id uuid nullable`, `data_access_event_id uuid nullable`, `domain_event_id uuid nullable`: physical FKs to possible Core source rows. Exactly one should be non-null and it must match `source_kind`; avoid a generic polymorphic `source_id` without a database FK.
- `evidence_kind text`: business/compliance category, such as `export`, `generated_document`, `import_file`, `signed_document`, `compliance_bundle`, or `action_snapshot`.
- `subject_module_key text nullable`, `subject_resource_type text nullable`, `subject_resource_id text nullable`: primary ResourceRef for finding evidence from a business object. Nullable because exports/reports may cover many resources or only tenant-level evidence.
- `evidence_policy_key text`: policy that required or allowed this evidence to be retained.
- `retention_policy_key text`: retention schedule that controls lifecycle/disposition.
- `artifact_content_sha256 text`: snapshot of `CORE_MEDIA_ASSETS.content_sha256` at the moment the artifact becomes evidence. This pins the exact bytes even if the asset later receives display metadata changes or the storage object is migrated.
- `storage_lock_scope text`: what the provider lock applies to, such as `none`, `object_version`, `object`, `bucket_prefix`, `bucket`, `container`, or `application_only`.
- `storage_lock_mode text`: provider retention mode, such as `none`, `governance`, `compliance`, `bucket_lock`, or `application_only`. Legal hold is separate because providers often model it independently from time-based retention.
- `storage_legal_hold boolean`: whether provider-side legal hold was observed for the artifact.
- `storage_retain_until timestamptz nullable`: provider-side retain-until timestamp if known.
- `storage_lock_status text`: current verification state, such as `not_required`, `application_only`, `pending`, `verified`, `failed`, or `expired`.
- `storage_lock_verified_at timestamptz nullable`: when OntOS last verified the provider lock metadata.
- `storage_lock_evidence_json jsonb`: small redacted provider metadata snapshot, such as S3 version id, retention mode, retain-until, legal-hold flag, matched bucket/prefix rule, or provider request id. It must not store the artifact bytes.
- `retain_until timestamptz nullable`: earliest time the artifact may be disposed of. Null means governed only by policy/defaults.
- `legal_hold_until timestamptz nullable`: hold override. Use PostgreSQL `infinity` if a hold has no known end date.
- `disposition_status text`: lifecycle of the evidence reference, such as `active`, `expired`, `deleted`, or `legal_hold`.
- `data_classification text`: classification used by access control, export control, and retention, such as `internal`, `confidential`, or `restricted`.
- `schema_key text nullable`: schema/manifest key for structured artifacts or bundles.
- `created_at timestamptz`, `updated_at timestamptz`, `deleted_at timestamptz nullable`: creation, mutable lifecycle metadata, and deletion tombstone.

The `text` columns above are not free-form text. In the first migrations, prefer `text` plus `CHECK` constraints and typed application schemas over PostgreSQL enums, because evidence kinds, classifications, and disposition states will likely evolve during early enterprise/compliance work.

Important constraints:

- `artifact_content_sha256` must equal the referenced media asset `content_sha256` at evidence registration time.
- Legal/compliance-grade evidence should require `storage_lock_status = verified` unless the evidence policy explicitly allows `application_only`.
- `application_only` is not provider WORM. It means OntOS prevents mutation through its own API, but an administrator with direct storage access could still bypass it.
- `media_asset_id` for legal/compliance-grade evidence must point to an immutable storage object, immutable object version, or a bucket/prefix/container rule that covers the object.
- Exactly one source FK must be set.
- `source_kind` must match the non-null source FK.
- `subject_*` should be all null or all non-null.
- `deleted_at` should be set only when `disposition_status = deleted`.
- `legal_hold_until` should prevent physical deletion even if `retain_until` has passed.
- Changes to retention, legal hold, disposition, or classification should be made through Actions and audited.

The hash and storage lock solve different problems. `content_sha256` proves integrity of the stored bytes. WORM/Object Lock proves that the storage provider prevented overwrite or deletion for the configured retention/hold period. Strong legal evidence usually needs both, plus action/audit context and retention policy. Postgres records the verification metadata; it does not replace storage-level WORM.

V0 intentionally does not put a redaction profile on `CORE_EVIDENCE_REFERENCES`. Redacted stored artifacts are a valid enterprise pattern, but they require a real redaction pipeline, profile registry, renderer tests, and product flows such as investor exports or support snapshots. Until those exist, evidence artifacts are treated as exact artifacts. `CORE_DATA_ACCESS_EVENTS.redaction_profile` remains only for `redacted_payload` read evidence.

Read-side evidence is separate from write-side actions. `CORE_DATA_ACCESS_EVENTS` should record important reads, lists, searches, exports, and downloads: who accessed what, query/filter hash, result count, result hash or artifact reference, and timestamp. The default should not be “store every full response body forever”; high-volume and sensitive reads need sampling, redaction, retention, and explicit product/security reasons.

`evidence_capture_mode` is not supplied by frontend code, API clients, or ad hoc handler logic. It is set by the Core runtime from an access evidence policy declared on the public endpoint/action descriptor.

Evidence capture modes:

- `metadata_only`: record actor, time, endpoint/action, target/query metadata, and context, but no result hash or payload. Use for ordinary detail reads or sensitive reads where duplicated evidence would create more risk than value.
- `hash_only`: record a canonical query hash and/or result fingerprint without storing the result content. Use when tamper evidence matters but content storage is unnecessary or risky. A fingerprint hash is one-way evidence; it cannot reconstruct what the user saw without a matching manifest, redacted payload, or stored artifact.
- `redacted_payload`: store a redacted snapshot or summary in `evidence_payload_json`. The descriptor must name a `redaction_profile`; that column is nullable for every other mode.
- `stored_artifact`: store the exact output outside the database, encrypted, as a `CORE_MEDIA_ASSETS` row and bind it through `CORE_EVIDENCE_REFERENCES`. The descriptor must define artifact kind, retention, classification, and encryption requirements.

System enforcement should be layered:

- Every public read/list/search/export/download endpoint must declare an access evidence policy. Missing policy should fail build or contract tests.
- The policy should be a typed discriminated union so `stored_artifact` cannot be declared without retention/encryption, and `redacted_payload` cannot be declared without a redaction profile.
- Public reads and exports should run through a runtime wrapper such as `withDataAccessEvidence(descriptor, handler)`. The wrapper writes `CORE_DATA_ACCESS_EVENTS`; handlers should not write arbitrary capture modes directly.
- Database constraints should enforce local mode-specific invariants, such as `redacted_payload` requiring `redaction_profile` and redacted payload, and non-redacted modes leaving `redaction_profile` null. `stored_artifact` should create a matching `CORE_MEDIA_ASSETS` + `CORE_EVIDENCE_REFERENCES` pair; enforce this with the runtime wrapper, contract tests, and if needed a deferred trigger because it is a cross-row invariant.
- Changes to evidence policies for sensitive endpoints should require product/security review, because switching from `stored_artifact` to `metadata_only` changes business evidence and security posture.

For data access events, `serving_module_key` is the module that served the read/list/search/export/download surface, even when the returned data came from other modules. It is the read-side equivalent of `producer_module_key`, but it uses a read-specific verb because a read evidence row is not a domain fact. For example, `reporting.basic` may serve a report that includes billing and property resources.

ResourceRef role names should stay role-specific:

- `subject_*`: the primary business resource a domain event or evidence artifact is about.
- `target_*`: the resource an action, audit checkpoint, data access event, or media link was aimed at.
- `source_*`: provenance of derived data, such as search documents or invoice line sources.

`result_fingerprint_hash` should be understood narrowly: it is a SHA-256 fingerprint of a canonical result representation, not stored content. The representation must be identified by `result_fingerprint_schema`, such as `resource_refs_v1`. A typical `resource_refs_v1` fingerprint should use stable fields such as `module_key`, `resource_type`, `resource_id`, and optionally resource version or updated timestamp. It should not depend on mutable display names or labels. If the business needs to know exactly what was shown or exported later, the evidence mode must be `redacted_payload` or `stored_artifact`, not only `hash_only`.

## Outbox messages

Outbox messages are technical delivery records. They are written transactionally with canonical data so that side effects are not lost when a process crashes between database write and external notification.

Outbox workers handle Neo4j projection, search projection, reporting refresh, accounting export preparation, future notifications, and future integration events. Handlers must be idempotent, retryable, observable, and capable of dead-lettering.

`CORE_WORKER_CHECKPOINTS` is for stream consumers that need a durable cursor through tenant-scoped domain events. It is mutable runtime state, not audit evidence. The natural key is `tenant_id + consumer_name + stream_key`; the stored position is `last_tenant_sequence_no`.

## Synchronous vs asynchronous work

Synchronous action execution should include authentication, authorization, policy checks, validation, canonical Postgres writes, audit/domain/outbox recording, and small local derived values. It should not include external API calls, Neo4j writes, search indexing, report recomputation, email/SMS delivery, or heavy imports.

Asynchronous workers should handle all side effects that can be retried or rebuilt. The user-facing action should return once canonical state is committed.

## Consistency levels

Operational ERP state is strongly consistent inside Postgres transactions. Graph, search, reporting, and integration projections are eventually consistent. The UI must be honest about this when necessary. For example, a graph view can show projection freshness or lag if relevant.

The architecture must tolerate projection failures. A failed Neo4j projection should not invalidate a created invoice. A failed accounting export worker should leave an export batch in a failed state for retry, not roll back the original invoice unless that was explicitly modeled as a reversible business action.

## Performance guardrails

The first implementation should include guardrails rather than assuming performance will be fine. Useful early measurements include API p95/p99 latency, DB query count per request, slow queries, event loop delay, SpiceDB check latency, outbox lag, worker duration, Neo4j projection lag, and search latency.

The runtime should avoid unbounded relation expansion, unbounded synchronous subscribers, per-result authorization calls in large search result sets, large event payloads, and heavy work inside request handlers.
