import { Schema } from 'effect';

export class CommercePortalAuthVerificationCallerUnavailable extends Schema.TaggedError<CommercePortalAuthVerificationCallerUnavailable>()(
  'CommercePortalAuthVerificationCallerUnavailable',
  {
    reason: Schema.String,
  },
) {}
