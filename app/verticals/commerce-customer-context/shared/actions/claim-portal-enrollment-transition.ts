import { Schema } from 'effect';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../enrollment-contracts.ts';

/** Tenant, Actor and the current Action invocation come only from the governed context. */
export const ClaimPortalEnrollmentTransitionPayloadSchema = Schema.Struct({
  expectedRevision: ClaimEnrollmentTransitionInputSchema.fields.expectedRevision,
  ownerInvocationId: ClaimEnrollmentTransitionInputSchema.fields.ownerInvocationId,
  ownerModuleKey: ClaimEnrollmentTransitionInputSchema.fields.ownerModuleKey,
  portalEnrollmentAttemptId: ClaimEnrollmentTransitionInputSchema.fields.portalEnrollmentAttemptId,
  requestDigest: ClaimEnrollmentTransitionInputSchema.fields.requestDigest,
  transitionKey: ClaimEnrollmentTransitionInputSchema.fields.transitionKey,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ClaimPortalEnrollmentTransitionPayload = typeof ClaimPortalEnrollmentTransitionPayloadSchema.Type;

export const ClaimPortalEnrollmentTransitionResultSchema = Schema.Struct({
  attempt: EnrollmentAttemptSnapshotSchema,
  operation: EnrollmentOwnerOperationSnapshotSchema,
  outcome: Schema.Literals(['CLAIMED', 'REPLAYED', 'ALREADY_CLAIMED']),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
