import { Schema } from 'effect';

export class CommercePortalAuthSessionReadUnavailable extends Schema.TaggedError<CommercePortalAuthSessionReadUnavailable>()(
  'CommercePortalAuthSessionReadUnavailable',
  {
    reason: Schema.String,
  },
) {}
