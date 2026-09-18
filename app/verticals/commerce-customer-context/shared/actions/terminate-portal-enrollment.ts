import { Schema } from 'effect';
import { TerminateEnrollmentAttemptInputSchema, EnrollmentAttemptSnapshotSchema } from '../enrollment-contracts.ts';

/** Tenant, Actor and the current Action invocation come only from the governed context. */
export const TerminatePortalEnrollmentPayloadSchema = Schema.Struct({
  expectedRevision: TerminateEnrollmentAttemptInputSchema.fields.expectedRevision,
  portalEnrollmentAttemptId: TerminateEnrollmentAttemptInputSchema.fields.portalEnrollmentAttemptId,
  reason: TerminateEnrollmentAttemptInputSchema.fields.reason,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type TerminatePortalEnrollmentPayload = typeof TerminatePortalEnrollmentPayloadSchema.Type;

export const TerminatePortalEnrollmentResultSchema = Schema.Struct({
  attempt: EnrollmentAttemptSnapshotSchema,
  outcome: Schema.Literals(['TERMINATED', 'ALREADY_TERMINAL']),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
