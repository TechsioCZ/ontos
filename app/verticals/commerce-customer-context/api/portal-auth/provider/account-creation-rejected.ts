import { Schema } from 'effect';

export class CommercePortalAuthAccountCreationRejected extends Schema.TaggedError<CommercePortalAuthAccountCreationRejected>()(
  'CommercePortalAuthAccountCreationRejected',
  {
    reason: Schema.String,
  },
) {}
