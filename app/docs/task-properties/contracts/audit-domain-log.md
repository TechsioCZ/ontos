# Task Property audit-log and domain-log contract

## Purpose and existing storage

Every accepted Task Property definition, configuration, option, or value change writes one audit record and one domain event using the existing Core tables:

- `core.audit_events`, whose native columns carry tenant, legal entity, actor/authentication context, action invocation, event type, outcome/stage/code, target resource, timestamp, audit profile, and `evidence_json`.
- `core.domain_events`, whose native columns carry tenant sequence, action invocation, producer/subject module, subject resource, event type, timestamp, and `payload_json`.

No Task Property history table, snapshot store, event-sourced aggregate, or additional reconstruction store is introduced.

## Write and retention guarantees

- An accepted business change and both records commit atomically. A failed or rolled-back business change produces no successful domain change event; separately governed rejection/failure audit evidence may still be written by Core.
- Records are append-only evidence. Corrections are later records, not updates that rewrite the original event.
- Both tables retain Task Property records indefinitely. There is no expiry, scheduled purge, age-based compaction, or datatype-specific retention period.
- Deleting live values, options, definitions, Tasks, or a Task Collection does not delete their prior audit/domain records.

## Access contract

- No product-facing audit-log or domain-log UI, export, or application read API is in scope.
- Task Collection roles do not grant log-table access.
- Only internal services that require the tables for governed runtime operation and separately governed database/operations personnel may access them. That operational access is outside Task Property role behavior.

## Privacy-safe payload profile

- Task Property audit `evidence_json` and domain `payload_json` contain metadata only: property/Task/option identifiers as needed to identify the subject, datatype key, operation/event key, resulting revision/version, changed-component names, outcome/redaction markers, and impact counts where the business action already exposes a count.
- Never place raw or formatted before/after Task Property values in either JSON payload. This includes Text content, Phone and Email strings, URLs, Person assignment identities, file bytes/names/external URLs, option labels/colors, dates, numbers, and reference labels.
- Never place editor drafts, upload bodies, authorization secrets, signed URLs, authentication tokens, or failed raw input in either log.
- Native actor, tenant, action, subject, event, outcome, and timestamp columns remain populated according to the current Core table contract. A stable resource identifier in a native subject/target column is evidence metadata, not a historical value snapshot.
- Producers must use the current audit profile/redaction mechanisms and reject a log descriptor that attempts to emit prohibited raw value content.

## Reconstruction guarantee

- These records prove that identified operations occurred, in tenant sequence/timestamp order, and identify their actor, subject, outcome, and resulting revision where recorded.
- They do not guarantee reconstruction of prior Task Property state, before/after values, a full Task snapshot, or replay into historical state.
- No product history, comparison, restore, rollback, undo, or time-travel behavior follows from these tables.

## Acceptance guarantees

- Changing Phone from one value to another creates metadata records but neither raw phone value appears in either JSON payload.
- Deleting a property leaves its earlier audit/domain rows present indefinitely.
- A Task Collection user cannot query the log merely because they can view or edit Tasks.
- Reading all retained rows can establish operation order and subjects but cannot reconstruct exact historical values.

## Sources and architecture evidence

- `../sources/handoffs/ontos-task-ticketing-handoff.md`.
- `../sources/handoffs/ontos-phone-property-handoff.md`.
- [PR-001](../product/product-resolutions.md#pr-001--audit-and-domain-logs-are-the-shared-version-record).
- Existing tables: `packages/core-runtime/src/db/schema.ts` (`auditEvents`, `domainEvents`).
- Existing writers: `packages/core-runtime/src/core-sdk.ts` (`writeAuditEvent`, `persistAutomaticDomainEvent`).
