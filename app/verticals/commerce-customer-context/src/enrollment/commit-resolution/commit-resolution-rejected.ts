import { Schema } from 'effect';

import { commitResolutionErrorFields } from './commit-resolution-fields.ts';

const rejectedFields = {
  ...commitResolutionErrorFields,
  retryable: Schema.Boolean,
} as const;

/**
 * Definitive, non-transient rejection: the original invocation is genuinely unknown to
 * `ActionRuntime`, the caller supplied invalid evidence, or the Core read found a binding for
 * the exact same subject with no recorded provenance (`originalInvocationId` absent) so
 * convergence cannot be proven safe.  `retryable` reflects whether resolving again with the same
 * inputs could plausibly change the outcome.
 */
export class CommerceEnrollmentCommitResolutionRejected extends Schema.TaggedError<CommerceEnrollmentCommitResolutionRejected>()(
  'CommerceEnrollmentCommitResolutionRejected',
  rejectedFields,
) {}
