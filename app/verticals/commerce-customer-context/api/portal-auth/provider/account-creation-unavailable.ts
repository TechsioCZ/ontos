import { Schema } from 'effect';

export class CommercePortalAuthAccountCreationUnavailable extends Schema.TaggedError<CommercePortalAuthAccountCreationUnavailable>()(
  'CommercePortalAuthAccountCreationUnavailable',
  {
    reason: Schema.String,
  },
) {}
