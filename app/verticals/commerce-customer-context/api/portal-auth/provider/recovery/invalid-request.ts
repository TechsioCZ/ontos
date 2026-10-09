import { Schema } from 'effect';

export class CommercePortalAuthRecoveryInvalidRequest extends Schema.TaggedError<CommercePortalAuthRecoveryInvalidRequest>()(
  'CommercePortalAuthRecoveryInvalidRequest',
  {
    reason: Schema.String,
  },
) {}
