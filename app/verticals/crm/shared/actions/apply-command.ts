import { Schema } from 'effect';
import { CrmScopeMismatch } from '../errors/crm-scope-mismatch.ts';
import { CrmNotFound } from '../errors/crm-not-found.ts';
import { CrmLifecycleConflict } from '../errors/crm-lifecycle-conflict.ts';
import { CrmRevisionConflict } from '../errors/crm-revision-conflict.ts';
import { CrmPersistenceUnavailable } from '../errors/crm-persistence-unavailable.ts';
import { CrmReferenceUnavailable } from '../errors/crm-reference-unavailable.ts';
import { CrmReferenceIneligible } from '../errors/crm-reference-ineligible.ts';
import { CrmPermissionDenied } from '../errors/crm-permission-denied.ts';
import { CrmCommandSchema } from '../commands/index.ts';

export { CrmCommandSchema } from '../commands/index.ts';
export type { CrmCommand } from '../commands/index.ts';
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: CrmCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
/** `entityIds[0]` is the created / primary affected entity. */
export const ApplyCommandResultSchema = Schema.Struct({
  entityIds: Schema.Array(Schema.String),
  revision: Schema.Int,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
export const CrmErrorSchema = Schema.Union([
  CrmScopeMismatch,
  CrmNotFound,
  CrmLifecycleConflict,
  CrmRevisionConflict,
  CrmPersistenceUnavailable,
  CrmReferenceUnavailable,
  CrmReferenceIneligible,
  CrmPermissionDenied,
]);
export type CrmError = typeof CrmErrorSchema.Type;
export { CrmScopeMismatch } from '../errors/crm-scope-mismatch.ts';
export { CrmNotFound } from '../errors/crm-not-found.ts';
export { CrmLifecycleConflict } from '../errors/crm-lifecycle-conflict.ts';
export { CrmRevisionConflict } from '../errors/crm-revision-conflict.ts';
export { CrmPersistenceUnavailable } from '../errors/crm-persistence-unavailable.ts';
export { CrmReferenceUnavailable } from '../errors/crm-reference-unavailable.ts';
export { CrmReferenceIneligible } from '../errors/crm-reference-ineligible.ts';
export { CrmPermissionDenied } from '../errors/crm-permission-denied.ts';
