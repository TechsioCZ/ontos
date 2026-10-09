import { Schema } from 'effect';
import type { Effect, Redacted } from 'effect';

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
/**
 * Better Auth 1.7.2 activates `method: 'otp'` immediately inside `/enable`
 * (`dist/plugins/two-factor/index.mjs:116-124`); only TOTP is staged until `/confirm-enable`. The
 * owner publishes only the staged enrollment flow, so `otp` is refused here at decode (400) rather
 * than forwarded to the provider.
 */
const MethodSchema = Schema.Literal('totp');

export const CommercePortalAuthMfaEnableBodySchema = Schema.Struct({
  issuer: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(MethodSchema),
  password: PasswordSchema,
});

export const CommercePortalAuthMfaDisableBodySchema = Schema.Struct({
  password: PasswordSchema,
});

export const CommercePortalAuthMfaPasswordBodySchema = Schema.Struct({
  password: PasswordSchema,
});

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

/**
 * A verification's private handoff. Better Auth answers a verification with the session it just
 * minted — a credential the owner must be able to take back when the completion evidence for that
 * verification is refused. It travels no further than the owner service that owns the compensation:
 * the published body stays the status result, so no token reaches a caller, a log or an audit row.
 */
export interface CommercePortalAuthMfaVerificationResponse extends CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult> {
  readonly issuedSessionToken: Redacted.Redacted;
}

/**
 * What an audit row may say about one MFA attempt. Both halves are digests keyed under the
 * deployment secret: the credential the attempt operates on, and the client it came from, which is
 * what ties a pre-mutation intent row to the completion row for the same attempt. Neither is a
 * cookie, a code or an address, and neither can be reversed into one.
 */
export interface CommercePortalAuthMfaAttemptEvidence {
  readonly clientKeyDigest: string;
  readonly subjectDigest: string;
}

/** The transport-derived half of every owner-audited MFA call; the provider never receives it. */
interface CommercePortalAuthMfaAuditedAttempt {
  readonly evidence: CommercePortalAuthMfaAttemptEvidence;
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

/**
 * The owner-service shapes for every state-changing call. They differ from the provider shapes by
 * the evidence alone, because the evidence exists for the audit rows the owner writes around the
 * provider call and has no meaning to Better Auth.
 *
 * `getTOTPURI` and `enableTwoFactor` have no shape here on purpose: neither takes a factor away
 * nor invalidates a credential a customer already holds, so neither is a mutation whose evidence a
 * support operator would miss. Disabling the second factor and regenerating the backup codes are
 * both, which is why they are audited exactly as a verification is.
 */
export type CommercePortalAuthMfaDisableServiceRequest = CommercePortalAuthMfaAuditedAttempt &
  CommercePortalAuthMfaDisableProviderRequest;
export type CommercePortalAuthMfaGenerateBackupCodesServiceRequest = CommercePortalAuthMfaAuditedAttempt &
  CommercePortalAuthMfaPasswordProviderRequest;
export type CommercePortalAuthMfaVerifyTotpServiceRequest = CommercePortalAuthMfaAuditedAttempt &
  CommercePortalAuthMfaVerifyTotpProviderRequest;
export type CommercePortalAuthMfaVerifyOtpServiceRequest = CommercePortalAuthMfaAuditedAttempt &
  CommercePortalAuthMfaVerifyOtpProviderRequest;
export type CommercePortalAuthMfaVerifyBackupCodeServiceRequest = CommercePortalAuthMfaAuditedAttempt &
  CommercePortalAuthMfaVerifyBackupCodeProviderRequest;

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
  ) => Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure>;
  readonly verifyTOTP: (
    input: CommercePortalAuthMfaVerifyTotpProviderRequest,
  ) => Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure>;
  readonly verifyTwoFactorOTP: (
    input: CommercePortalAuthMfaVerifyOtpProviderRequest,
  ) => Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure>;
}
