import { Schema } from 'effect';
import { EnrollmentAttemptIntentSchema, EnrollmentAttemptSnapshotSchema } from '../enrollment-contracts.ts';

/** Tenant, Actor and the current Action invocation come only from the governed context. */
export const StartPortalEnrollmentPayloadSchema = EnrollmentAttemptIntentSchema;
export type StartPortalEnrollmentPayload = typeof StartPortalEnrollmentPayloadSchema.Type;

export const StartPortalEnrollmentResultSchema = Schema.Struct({
  attempt: EnrollmentAttemptSnapshotSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING']),
});
