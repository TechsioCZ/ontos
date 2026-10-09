import { AuthBindingStatusSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

import { EnrollmentActionInvocationIdSchema } from '../../../shared/enrollment-contracts.ts';

/**
 * Fields shared by every commit-resolution error.  `invocationId` is always the ORIGINAL
 * invocation identity the caller asked to resolve — never a newly minted one — so a report
 * built from one of these errors can be correlated back to the exact Action attempt.
 */
const commitResolutionErrorFields = {
  code: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)),
  invocationId: EnrollmentActionInvocationIdSchema,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
} as const;

const rejectedFields = { ...commitResolutionErrorFields, retryable: Schema.Boolean } as const;
const CommerceEnrollmentCommitResolutionRejectedSchema = Schema.TaggedStruct(
  'CommerceEnrollmentCommitResolutionRejected',
  rejectedFields,
);
/**
 * Definitive, non-transient rejection: the original invocation is genuinely unknown to
 * `ActionRuntime`, the caller supplied invalid evidence, or the Core read found a binding for
 * the exact same subject with no recorded provenance (`originalInvocationId` absent) so
 * convergence cannot be proven safe.  `retryable` reflects whether resolving again with the same
 * inputs could plausibly change the outcome.
 */
export const CommerceEnrollmentCommitResolutionRejected = Schema.TaggedError<
  typeof CommerceEnrollmentCommitResolutionRejectedSchema.Type
>()('CommerceEnrollmentCommitResolutionRejected', rejectedFields);

const revokedFields = {
  ...commitResolutionErrorFields,
  bindingStatus: AuthBindingStatusSchema,
  retryable: Schema.Literal(false),
} as const;
const CommerceEnrollmentCommitResolutionRevokedSchema = Schema.TaggedStruct(
  'CommerceEnrollmentCommitResolutionRevoked',
  revokedFields,
);
/**
 * The exact original invocation IS on record as historically committed (the governed Core read
 * matches this invocation's own provenance), but the retained binding is no longer current
 * (`disabled` or `revoked`).  Treating this as a success would resurrect authority a later
 * administrative transition already withdrew, so resolution fails closed instead.  Not retryable
 * by re-resolving the same invocation; the caller must route to reconciliation.
 */
export const CommerceEnrollmentCommitResolutionRevoked = Schema.TaggedError<
  typeof CommerceEnrollmentCommitResolutionRevokedSchema.Type
>()('CommerceEnrollmentCommitResolutionRevoked', revokedFields);

const unavailableFields = { ...commitResolutionErrorFields, retryable: Schema.Literal(true) } as const;
const CommerceEnrollmentCommitResolutionUnavailableSchema = Schema.TaggedStruct(
  'CommerceEnrollmentCommitResolutionUnavailable',
  unavailableFields,
);
/**
 * The Action commit state or the governed Core read could not be determined right now
 * (indeterminate commit, transport failure, malformed evidence).  The caller should retry the
 * resolution itself — never mint a new Action invocation to work around it.
 */
export const CommerceEnrollmentCommitResolutionUnavailable = Schema.TaggedError<
  typeof CommerceEnrollmentCommitResolutionUnavailableSchema.Type
>()('CommerceEnrollmentCommitResolutionUnavailable', unavailableFields);

export type CommerceEnrollmentCommitResolutionError =
  | InstanceType<typeof CommerceEnrollmentCommitResolutionRejected>
  | InstanceType<typeof CommerceEnrollmentCommitResolutionRevoked>
  | InstanceType<typeof CommerceEnrollmentCommitResolutionUnavailable>;
