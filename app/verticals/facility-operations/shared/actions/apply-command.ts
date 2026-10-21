import { Schema } from 'effect';
import { FacilityOperationsScopeMismatch } from '../errors/facility-operations-scope-mismatch.ts';
import { FacilityOperationsNotFound } from '../errors/facility-operations-not-found.ts';
import { FacilityOperationsLifecycleConflict } from '../errors/facility-operations-lifecycle-conflict.ts';
import { FacilityOperationsRevisionConflict } from '../errors/facility-operations-revision-conflict.ts';
import { FacilityOperationsPersistenceUnavailable } from '../errors/facility-operations-persistence-unavailable.ts';
import { FacilityOperationsReferenceUnavailable } from '../errors/facility-operations-reference-unavailable.ts';
import { FacilityOperationsReferenceIneligible } from '../errors/facility-operations-reference-ineligible.ts';
import { FacilityOperationsPermissionDenied } from '../errors/facility-operations-permission-denied.ts';
import { FacilityOperationsNotImplemented } from '../errors/facility-operations-not-implemented.ts';
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
  /**
   * `updatedAt` of the agenda envelope the client built the command from. When present and the agenda revision has
   * moved on, the command is re-applied to the current state unless a record it changes was itself changed after
   * this instant (per-record conflicts instead of whole-agenda conflicts).
   */
  baseUpdatedAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
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
export const FacilityOperationsErrorSchema = Schema.Union([
  FacilityOperationsScopeMismatch,
  FacilityOperationsNotFound,
  FacilityOperationsLifecycleConflict,
  FacilityOperationsRevisionConflict,
  FacilityOperationsPersistenceUnavailable,
  FacilityOperationsReferenceUnavailable,
  FacilityOperationsReferenceIneligible,
  FacilityOperationsPermissionDenied,
  FacilityOperationsNotImplemented,
]);
export type FacilityOperationsError = typeof FacilityOperationsErrorSchema.Type;
export { FacilityOperationsScopeMismatch } from '../errors/facility-operations-scope-mismatch.ts';
export { FacilityOperationsNotFound } from '../errors/facility-operations-not-found.ts';
export { FacilityOperationsLifecycleConflict } from '../errors/facility-operations-lifecycle-conflict.ts';
export { FacilityOperationsRevisionConflict } from '../errors/facility-operations-revision-conflict.ts';
export { FacilityOperationsPersistenceUnavailable } from '../errors/facility-operations-persistence-unavailable.ts';
export { FacilityOperationsReferenceUnavailable } from '../errors/facility-operations-reference-unavailable.ts';
export { FacilityOperationsReferenceIneligible } from '../errors/facility-operations-reference-ineligible.ts';
export { FacilityOperationsPermissionDenied } from '../errors/facility-operations-permission-denied.ts';
export { FacilityOperationsNotImplemented } from '../errors/facility-operations-not-implemented.ts';
