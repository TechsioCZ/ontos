import { Schema } from 'effect';
import type { Effect } from 'effect';

import type {
  CommercePortalAuthMfaBackupCodesResult,
  CommercePortalAuthMfaEnableResult,
  CommercePortalAuthMfaStatusResult,
  CommercePortalAuthMfaTotpUriResult,
  CommercePortalAuthMfaVerificationResult,
} from '../../../../shared/portal-auth/mfa-api.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import type { CommercePortalAuthMfaChallengeExpired } from './challenge-expired.ts';
import type { CommercePortalAuthMfaProviderRejected } from './provider-rejected.ts';
import type { CommercePortalAuthMfaProviderUnavailable } from './provider-unavailable.ts';
import type { CommercePortalAuthMfaRateLimited } from './rate-limited.ts';

/**
 * The published wire shapes stay the provider-response contract so the transport, the owner
 * service and the Better Auth adapter cannot drift apart.
 */
export {
  CommercePortalAuthMfaBackupCodesResultSchema,
  CommercePortalAuthMfaEnableResultSchema,
  CommercePortalAuthMfaStatusResultSchema,
  CommercePortalAuthMfaTotpUriResultSchema,
  CommercePortalAuthMfaVerificationResultSchema,
  CommercePortalAuthMfaVerifyBackupCodeBodySchema,
  CommercePortalAuthMfaVerifyTotpBodySchema,
} from '../../../../shared/portal-auth/mfa-api.ts';
export type {
  CommercePortalAuthMfaBackupCodesResult,
  CommercePortalAuthMfaEnableResult,
  CommercePortalAuthMfaStatusResult,
  CommercePortalAuthMfaTotpUriResult,
  CommercePortalAuthMfaVerificationResult,
} from '../../../../shared/portal-auth/mfa-api.ts';

/**
 * Policy-bound password re-validation. The published `enable`/`disable`/`regenerate-backup-codes`/
 * `totp-uri` payloads (`shared/portal-auth/mfa-api.ts`) bound `password` only loosely at the public
 * boundary — like `session-api.ts`'s sign-in password, it crosses the wire as a plain string. The
 * HTTP transport re-decodes the already-parsed payload through these schemas before any Better Auth
 * call, so a caller-supplied value outside policy bounds surfaces as the owner's `invalid_request`
 * problem rather than a raw provider rejection.
 */
const PasswordSchema = Schema.String.check(
  Schema.isMinLength(COMMERCE_PORTAL_AUTH_POLICY.password.minLength),
  Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
);
const MethodSchema = Schema.Literals(['otp', 'totp']);

export const CommercePortalAuthMfaEnableBodySchema = Schema.Struct({
  issuer: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(MethodSchema),
  password: PasswordSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthMfaDisableBodySchema = Schema.Struct({
  password: PasswordSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthMfaPasswordBodySchema = Schema.Struct({
  password: PasswordSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

type CommercePortalAuthMfaEnableBody = typeof CommercePortalAuthMfaEnableBodySchema.Type;
type CommercePortalAuthMfaDisableBody = typeof CommercePortalAuthMfaDisableBodySchema.Type;
type CommercePortalAuthMfaPasswordBody = typeof CommercePortalAuthMfaPasswordBodySchema.Type;

interface CommercePortalAuthMfaProviderRequest<Body> {
  readonly body: Body;
  readonly headers: Headers;
}

/**
 * Private response metadata returned by Better Auth. Callers may forward these headers to the
 * browser, but must never include them in JSON, logs, Core evidence, or application events.
 */
export interface CommercePortalAuthMfaResponse<Body> {
  readonly body: Body;
  readonly setCookieHeaders: readonly string[];
}

export type CommercePortalAuthMfaProviderFailure =
  | CommercePortalAuthMfaChallengeExpired
  | CommercePortalAuthMfaProviderRejected
  | CommercePortalAuthMfaProviderUnavailable
  | CommercePortalAuthMfaRateLimited;

export type CommercePortalAuthMfaEnableProviderRequest =
  CommercePortalAuthMfaProviderRequest<CommercePortalAuthMfaEnableBody>;
export type CommercePortalAuthMfaDisableProviderRequest =
  CommercePortalAuthMfaProviderRequest<CommercePortalAuthMfaDisableBody>;
/** The provider never receives a trusted-device request; the transport narrows the value first. */
export type CommercePortalAuthMfaSendOtpProviderRequest = CommercePortalAuthMfaProviderRequest<{
  readonly trustDevice?: false;
}>;
export type CommercePortalAuthMfaVerifyTotpProviderRequest = CommercePortalAuthMfaProviderRequest<{
  readonly code: string;
  readonly trustDevice?: false;
}>;
export type CommercePortalAuthMfaVerifyOtpProviderRequest = CommercePortalAuthMfaProviderRequest<{
  readonly code: string;
  readonly trustDevice?: false;
}>;
/**
 * The provider is never asked to skip the session it just minted: `disableSession` makes Better
 * Auth answer a consumed backup code with a body this owner cannot decode (see
 * `shared/portal-auth/mfa-api.ts`), so the field is absent from the request the owner can express.
 */
export type CommercePortalAuthMfaVerifyBackupCodeProviderRequest = CommercePortalAuthMfaProviderRequest<{
  readonly code: string;
  readonly trustDevice?: false;
}>;
export type CommercePortalAuthMfaPasswordProviderRequest =
  CommercePortalAuthMfaProviderRequest<CommercePortalAuthMfaPasswordBody>;

export interface CommercePortalAuthMfaProvider {
  readonly disableTwoFactor: (
    input: CommercePortalAuthMfaDisableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly enableTwoFactor: (
    input: CommercePortalAuthMfaEnableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaEnableResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly generateBackupCodes: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaBackupCodesResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly getTOTPURI: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaTotpUriResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly sendTwoFactorOTP: (
    input: CommercePortalAuthMfaSendOtpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyBackupCode: (
    input: CommercePortalAuthMfaVerifyBackupCodeProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTOTP: (
    input: CommercePortalAuthMfaVerifyTotpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTwoFactorOTP: (
    input: CommercePortalAuthMfaVerifyOtpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
}
