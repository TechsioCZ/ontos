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
const input = <Type extends 'jsonb' | 'text' | 'uuid'>(type: Type) => ({ source: 'input', type }) as const;

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
  parameters: [tenant, input('uuid'), input('uuid')] as const,
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
