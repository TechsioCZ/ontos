import { Schema } from 'effect';
import {
  ReconcileEnrollmentRequestSchema,
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../enrollment-contracts.ts';

/** Tenant, Actor and the current Action invocation come only from the governed context. */
/** Requests authoritative recovery; outcome and provider identity are never caller assertions. */
export const RecordPortalEnrollmentOutcomePayloadSchema = Schema.Struct({
  expectedRevision: ReconcileEnrollmentRequestSchema.fields.expectedRevision,
  ownerInvocationId: ReconcileEnrollmentRequestSchema.fields.ownerInvocationId,
  ownerModuleKey: ReconcileEnrollmentRequestSchema.fields.ownerModuleKey,
  portalEnrollmentAttemptId: ReconcileEnrollmentRequestSchema.fields.portalEnrollmentAttemptId,
  transitionKey: ReconcileEnrollmentRequestSchema.fields.transitionKey,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type RecordPortalEnrollmentOutcomePayload = typeof RecordPortalEnrollmentOutcomePayloadSchema.Type;

export const RecordPortalEnrollmentOutcomeResultSchema = Schema.Struct({
  attempt: EnrollmentAttemptSnapshotSchema,
  operation: EnrollmentOwnerOperationSnapshotSchema,
  outcome: Schema.Literal('RECORDED'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
