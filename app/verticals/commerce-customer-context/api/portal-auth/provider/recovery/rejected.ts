import { Schema } from 'effect';

export class CommercePortalAuthRecoveryRejected extends Schema.TaggedError<CommercePortalAuthRecoveryRejected>()(
  'CommercePortalAuthRecoveryRejected',
  {
    code: Schema.Literals(['INVALID_TOKEN', 'INVALID_SUBJECT', 'PROVIDER_REJECTED', 'RATE_LIMITED']),
    operation: Schema.String,
    reason: Schema.String,
  },
) {}
