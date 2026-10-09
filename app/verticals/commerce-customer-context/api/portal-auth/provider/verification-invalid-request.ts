import { Schema } from 'effect';

export class CommercePortalAuthVerificationInvalidRequest extends Schema.TaggedError<CommercePortalAuthVerificationInvalidRequest>()(
  'CommercePortalAuthVerificationInvalidRequest',
  {
    reason: Schema.String,
  },
) {}
