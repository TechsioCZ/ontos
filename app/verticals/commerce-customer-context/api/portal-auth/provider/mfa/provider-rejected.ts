import { Schema } from 'effect';

/** Better Auth rejection codes that are safe to classify without exposing provider diagnostics. */
export const CommercePortalAuthMfaProviderRejectionCodeSchema = Schema.Literals([
  'BACKUP_CODES_NOT_ENABLED',
  'INVALID_BACKUP_CODE',
  'INVALID_CODE',
  'INVALID_EMAIL',
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_PASSWORD',
  'INVALID_REQUEST',
  'INVALID_TWO_FACTOR_COOKIE',
  'INVALID_USERNAME_OR_PASSWORD',
  'OTP_NOT_CONFIGURED',
  'OTP_NOT_ENABLED',
  'PROVIDER_REJECTED',
  'TOTP_NOT_CONFIGURED',
  'TOTP_NOT_ENABLED',
  'TWO_FACTOR_NOT_ENABLED',
] as const);

export class CommercePortalAuthMfaProviderRejected extends Schema.TaggedError<CommercePortalAuthMfaProviderRejected>()(
  'CommercePortalAuthMfaProviderRejected',
  {
    code: CommercePortalAuthMfaProviderRejectionCodeSchema,
    operation: Schema.String,
    reason: Schema.String,
    /** Private handoff; the HTTP adapter forwards these values and never serializes them. */
    setCookieHeaders: Schema.Array(Schema.String),
  },
) {}
