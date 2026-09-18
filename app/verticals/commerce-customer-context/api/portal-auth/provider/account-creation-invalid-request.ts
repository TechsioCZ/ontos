import { Schema } from 'effect';

export class CommercePortalAuthAccountCreationInvalidRequest extends Schema.TaggedError<CommercePortalAuthAccountCreationInvalidRequest>()(
  'CommercePortalAuthAccountCreationInvalidRequest',
  {
    reason: Schema.String,
  },
) {}
