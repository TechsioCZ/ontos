import { Schema } from 'effect';

export class CommercePortalAuthMfaChallengeExpired extends Schema.TaggedError<CommercePortalAuthMfaChallengeExpired>()(
  'CommercePortalAuthMfaChallengeExpired',
  {
    operation: Schema.String,
    reason: Schema.String,
    /** Private handoff; the HTTP adapter forwards these values and never serializes them. */
    setCookieHeaders: Schema.Array(Schema.String),
  },
) {}
