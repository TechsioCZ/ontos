import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

/**
 * The frozen routine surface the pre-handoff worker and the language-policy snapshot use (migration
 * `enforce-communication-intake`). A worker holds no database executor: every call goes through the routine invoker of
 * the Core-verified Tenant scope, and each routine refuses a Tenant other than the installed one. Every routine returns
 * one jsonb `result` document per row; the owner decodes it with its own Schema at the call site.
 */
const OWNER_MODULE_KEY = 'communications.core';
const ROUTINE_SCHEMA = 'communications';
const tenant = { source: 'tenantId', type: 'uuid' } as const;
const input = <Type extends 'integer' | 'jsonb' | 'text' | 'uuid'>(type: Type) => ({ source: 'input', type }) as const;

/** A routine row as the invoker decodes it: the document is decoded again by the owner, never trusted as typed. */
const documentRow = Schema.Struct({ result: Schema.Unknown });

export const readLanguagePolicySnapshotRoutine = defineScopedRoutine({
  name: 'read_language_policy_snapshot',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant] as const,
  resultSchema: documentRow,
  routineKey: 'communications.read-language-policy-snapshot',
  schema: ROUTINE_SCHEMA,
});

export const workerReadIntentRoutine = defineScopedRoutine({
  name: 'worker_read_intent',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-read-intent',
  schema: ROUTINE_SCHEMA,
});

export const workerReadTemplateSnapshotRoutine = defineScopedRoutine({
  name: 'worker_read_template_snapshot',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    tenant,
    input('text'),
    input('text'),
    input('text'),
    { nullable: true, source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-read-template-snapshot',
  schema: ROUTINE_SCHEMA,
});

export const workerBeginAttemptRoutine = defineScopedRoutine({
  name: 'worker_begin_attempt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('uuid'), input('integer')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-begin-attempt',
  schema: ROUTINE_SCHEMA,
});

export const workerRecordStopRoutine = defineScopedRoutine({
  name: 'worker_record_stop',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('jsonb')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-record-stop',
  schema: ROUTINE_SCHEMA,
});

export const workerFinishAttemptRoutine = defineScopedRoutine({
  name: 'worker_finish_attempt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('text'), input('jsonb')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-finish-attempt',
  schema: ROUTINE_SCHEMA,
});

/**
 * The history routines (#1402, migration `enforce-message-history`). Same rules as above: no executor, the Core-verified Tenant
 * is the first argument and each routine refuses another one. `ingestProviderObservation` carries the Tenant the CALLER claims
 * as an input too, so a callback that names another Tenant is answered `UNBOUND` and never reaches another Tenant's rows.
 */
export const ingestProviderObservationRoutine = defineScopedRoutine({
  name: 'ingest_provider_observation',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    tenant,
    input('uuid'),
    input('uuid'),
    input('uuid'),
    input('uuid'),
    input('text'),
    input('text'),
    { nullable: true, source: 'input', type: 'text' },
    input('text'),
    { source: 'input', type: 'timestamptz' },
    input('jsonb'),
  ] as const,
  resultSchema: documentRow,
  routineKey: 'communications.ingest-provider-observation',
  schema: ROUTINE_SCHEMA,
});

export const workerLinkRetryAttemptRoutine = defineScopedRoutine({
  name: 'worker_link_retry_attempt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    tenant,
    input('uuid'),
    input('uuid'),
    input('uuid'),
    input('text'),
    input('text'),
    { nullable: true, source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-link-retry-attempt',
  schema: ROUTINE_SCHEMA,
});

/**
 * The recovery routines (#1403, migration `enforce-recovery-and-resend`). Same rules as above: no executor, the Core-verified
 * Tenant is the first argument and each routine refuses another one. None of them can call a provider: they only record why an
 * attempt may follow, that an evaluation did not continue the intent, or that a conflict of provider evidence was settled.
 */
export const workerBeginRetryAttemptRoutine = defineScopedRoutine({
  name: 'worker_begin_retry_attempt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    tenant,
    input('uuid'),
    input('uuid'),
    input('integer'),
    input('uuid'),
    input('text'),
    { nullable: true, source: 'input', type: 'uuid' },
    input('text'),
  ] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-begin-retry-attempt',
  schema: ROUTINE_SCHEMA,
});

export const workerCloseUnansweredAttemptRoutine = defineScopedRoutine({
  name: 'worker_close_unanswered_attempt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('integer')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-close-unanswered-attempt',
  schema: ROUTINE_SCHEMA,
});

export const workerRecordRecoveryEvaluationRoutine = defineScopedRoutine({
  name: 'worker_record_recovery_evaluation',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('uuid'), input('text'), input('text'), input('jsonb')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-record-recovery-evaluation',
  schema: ROUTINE_SCHEMA,
});

export const workerResolveObservationConflictRoutine = defineScopedRoutine({
  name: 'worker_resolve_observation_conflict',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [tenant, input('uuid'), input('uuid'), input('uuid'), input('text')] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-resolve-observation-conflict',
  schema: ROUTINE_SCHEMA,
});

/**
 * The document pin routine (#1409, migration `enforce-document-pins`). Same rules as above: no executor, the Core-verified
 * Tenant is the first argument. It stores the owner's first answer for one document of an intent and always returns the stored
 * pin, so a document is never repointed.
 */
export const workerPinDocumentRoutine = defineScopedRoutine({
  name: 'worker_pin_document',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    tenant,
    input('uuid'),
    input('integer'),
    input('text'),
    input('text'),
    input('text'),
    input('text'),
    input('text'),
    input('text'),
    input('text'),
    input('text'),
    input('integer'),
  ] as const,
  resultSchema: documentRow,
  routineKey: 'communications.worker-pin-document',
  schema: ROUTINE_SCHEMA,
});
