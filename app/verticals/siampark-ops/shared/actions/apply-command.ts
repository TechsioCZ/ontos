import { Schema } from 'effect';
import { SiamparkOpsScopeMismatch } from '../errors/siampark-ops-scope-mismatch.ts';
import { SiamparkOpsNotFound } from '../errors/siampark-ops-not-found.ts';
import { SiamparkOpsLifecycleConflict } from '../errors/siampark-ops-lifecycle-conflict.ts';
import { SiamparkOpsRevisionConflict } from '../errors/siampark-ops-revision-conflict.ts';
import { SiamparkOpsPersistenceUnavailable } from '../errors/siampark-ops-persistence-unavailable.ts';
import { SiamparkOpsReferenceUnavailable } from '../errors/siampark-ops-reference-unavailable.ts';
import { SiamparkOpsReferenceIneligible } from '../errors/siampark-ops-reference-ineligible.ts';
import { SiamparkOpsPermissionDenied } from '../errors/siampark-ops-permission-denied.ts';
import { SiamparkOpsNotImplemented } from '../errors/siampark-ops-not-implemented.ts';
import { OpsCommandSchema } from '../agendas.ts';
import { AgendaIdSchema, EntityIdSchema } from '../domain/common.ts';
import { StoredFileRefSchema } from '../domain/documents.ts';

export { OpsCommandSchema } from '../agendas.ts';
export type { OpsCommand } from '../agendas.ts';

/**
 * One governed Action for every agenda. `expectedRevision` is the revision of the agenda that owns the command
 * (each agenda has its own row and revision; see records read `agendas.<id>.revision`). FileUpload ignores it.
 */
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: OpsCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
/** Identifiers of the entities the command created or changed, the new revision of the owning agenda. */
export const ApplyCommandResultSchema = Schema.Struct({
  agenda: Schema.optionalKey(AgendaIdSchema),
  entityIds: Schema.Array(EntityIdSchema),
  /** Present for FileUpload: snapshot to store in a documents record. */
  file: Schema.optionalKey(StoredFileRefSchema),
  revision: Schema.Int,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
export const SiamparkOpsErrorSchema = Schema.Union([
  SiamparkOpsScopeMismatch,
  SiamparkOpsNotFound,
  SiamparkOpsLifecycleConflict,
  SiamparkOpsRevisionConflict,
  SiamparkOpsPersistenceUnavailable,
  SiamparkOpsReferenceUnavailable,
  SiamparkOpsReferenceIneligible,
  SiamparkOpsPermissionDenied,
  SiamparkOpsNotImplemented,
]);
export type SiamparkOpsError = typeof SiamparkOpsErrorSchema.Type;
export { SiamparkOpsScopeMismatch } from '../errors/siampark-ops-scope-mismatch.ts';
export { SiamparkOpsNotFound } from '../errors/siampark-ops-not-found.ts';
export { SiamparkOpsLifecycleConflict } from '../errors/siampark-ops-lifecycle-conflict.ts';
export { SiamparkOpsRevisionConflict } from '../errors/siampark-ops-revision-conflict.ts';
export { SiamparkOpsPersistenceUnavailable } from '../errors/siampark-ops-persistence-unavailable.ts';
export { SiamparkOpsReferenceUnavailable } from '../errors/siampark-ops-reference-unavailable.ts';
export { SiamparkOpsReferenceIneligible } from '../errors/siampark-ops-reference-ineligible.ts';
export { SiamparkOpsPermissionDenied } from '../errors/siampark-ops-permission-denied.ts';
export { SiamparkOpsNotImplemented } from '../errors/siampark-ops-not-implemented.ts';
