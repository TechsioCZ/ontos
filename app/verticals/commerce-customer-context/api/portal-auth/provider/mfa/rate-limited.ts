import { Schema } from 'effect';

export const CommercePortalAuthMfaRateLimitCodeSchema = Schema.Literals([
  'ACCOUNT_TEMPORARILY_LOCKED',
  'RATE_LIMITED',
  'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
  'TOO_MANY_REQUESTS',
] as const);

export class CommercePortalAuthMfaRateLimited extends Schema.TaggedError<CommercePortalAuthMfaRateLimited>()(
  'CommercePortalAuthMfaRateLimited',
  {
    code: CommercePortalAuthMfaRateLimitCodeSchema,
    operation: Schema.String,
    reason: Schema.String,
    /** Private handoff; the HTTP adapter forwards these values and never serializes them. */
    setCookieHeaders: Schema.Array(Schema.String),
  },
) {}
