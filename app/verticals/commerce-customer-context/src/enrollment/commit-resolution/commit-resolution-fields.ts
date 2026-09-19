import { Schema } from 'effect';

import { EnrollmentActionInvocationIdSchema } from '../../../shared/enrollment-contracts.ts';

/**
 * Fields shared by every commit-resolution error.  `invocationId` is always the ORIGINAL
 * invocation identity the caller asked to resolve — never a newly minted one — so a report
 * built from one of these errors can be correlated back to the exact Action attempt.
 */
export const commitResolutionErrorFields = {
  code: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)),
  invocationId: EnrollmentActionInvocationIdSchema,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
} as const;
