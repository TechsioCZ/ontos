import { Schema } from 'effect';

export class CommercePortalAuthRecoveryUnavailable extends Schema.TaggedError<CommercePortalAuthRecoveryUnavailable>()(
  'CommercePortalAuthRecoveryUnavailable',
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}
