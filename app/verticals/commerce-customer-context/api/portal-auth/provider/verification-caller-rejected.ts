import { Schema } from 'effect';

export class CommercePortalAuthVerificationCallerRejected extends Schema.TaggedError<CommercePortalAuthVerificationCallerRejected>()(
  'CommercePortalAuthVerificationCallerRejected',
  {
    reason: Schema.String,
  },
) {}
