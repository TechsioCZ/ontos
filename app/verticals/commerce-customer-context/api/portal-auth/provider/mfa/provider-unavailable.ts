import { Schema } from 'effect';

export class CommercePortalAuthMfaProviderUnavailable extends Schema.TaggedError<CommercePortalAuthMfaProviderUnavailable>()(
  'CommercePortalAuthMfaProviderUnavailable',
  {
    operation: Schema.String,
    reason: Schema.String,
    /** Private handoff; the HTTP adapter forwards these values and never serializes them. */
    setCookieHeaders: Schema.Array(Schema.String),
  },
) {}
