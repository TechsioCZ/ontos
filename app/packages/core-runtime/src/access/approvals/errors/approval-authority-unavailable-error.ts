import { Schema } from 'effect';

/** The authority projection could not answer. This is a retryable failure, never a denial. */
export class ApprovalAuthorityUnavailableError extends Schema.TaggedError<ApprovalAuthorityUnavailableError>()(
  'ApprovalAuthorityUnavailableError',
  {
    code: Schema.Literal('approval_authority_unavailable'),
    reason: Schema.String,
  },
) {}
