import { Effect, Layer } from '@modern-js/bff-effect/effect-edge';
import { Schema } from 'effect';
import { HttpApiError } from 'effect/unstable/httpapi';
import type { HttpServerResponse } from 'effect/unstable/http';

import {
  CommercePortalAuthMfaAuthenticationProblemSchema,
  CommercePortalAuthMfaForbiddenProblemSchema,
  CommercePortalAuthMfaInvalidProblemSchema,
  CommercePortalAuthMfaRateLimitedProblemSchema,
  CommercePortalAuthMfaSchemaErrorMiddleware,
  CommercePortalAuthMfaUnavailableProblemSchema,
} from '../../../../shared/portal-auth/mfa-api.ts';
import type { CommercePortalAuthMfaProblem } from '../../../../shared/portal-auth/mfa-api.ts';
import { withCause } from '../../problems-support.ts';
import { CommercePortalAuthMfaChallengeExpired } from './challenge-expired.ts';
import type { CommercePortalAuthMfaProviderFailure } from './contracts.ts';
import { CommercePortalAuthMfaProviderRejected } from './provider-rejected.ts';
import { CommercePortalAuthMfaRateLimited } from './rate-limited.ts';

const problemStatus = {
  authentication: 401,
  forbidden: 403,
  invalid: 400,
  rateLimited: 429,
  unavailable: 503,
} as const;

export const commercePortalAuthMfaInvalidProblem = CommercePortalAuthMfaInvalidProblemSchema.make({
  code: 'invalid_request',
  detail: 'The authentication request is invalid.',
  status: problemStatus.invalid,
  title: 'Invalid MFA request',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-invalid',
});

interface CommercePortalAuthMfaInvalidBodyCause {
  readonly kind: 'invalid-request-body';
}

/**
 * The owner's re-validation schemas cover `password`, so the raw `Schema.decodeUnknownEffect`
 * failure can carry the submitted password inside its parse issue — it is never kept, only a
 * non-sensitive marker is.
 */
const invalidRequestBodyCause = <ParseFailure>(_cause: ParseFailure): CommercePortalAuthMfaInvalidBodyCause => ({
  kind: 'invalid-request-body',
});

/**
 * Used wherever the owner's tighter re-validation schema (`contracts.ts`) rejects an
 * already-schema-decoded payload — `enable`, `disable`, `regenerate-backup-codes` and `totp-uri` all
 * re-decode a `password` field this way. Never attach the raw parse failure directly: it can quote
 * the submitted password back in its issue message. The singleton problem is copied first, so
 * concurrent requests never race over one shared instance's `cause`.
 */
export const commercePortalAuthMfaInvalidRequestProblem = (cause: unknown) =>
  withCause({ ...commercePortalAuthMfaInvalidProblem }, invalidRequestBodyCause(cause));

export const commercePortalAuthMfaTrustDeviceProblem = CommercePortalAuthMfaInvalidProblemSchema.make({
  code: 'trust_device_not_allowed',
  detail: 'Trusted-device cookies are not permitted.',
  status: problemStatus.invalid,
  title: 'Trusted device not allowed',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-trust-device-not-allowed',
});

/**
 * Answered by the owner-enforced fresh-authentication gate ahead of `enable`, `confirm-enable`,
 * `disable`, `regenerate-backup-codes` and `totp-uri`: the current session is absent, unreadable, or
 * older than `COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds`. Better Auth's own two-factor
 * plugin endpoints never consult `freshAge`, so this is the only place that window is enforced.
 */
export const commercePortalAuthMfaNotFreshProblem = CommercePortalAuthMfaAuthenticationProblemSchema.make({
  code: 'mfa_authentication_not_fresh',
  detail: 'This action requires a recently authenticated session.',
  status: problemStatus.authentication,
  title: 'MFA authentication not fresh',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-authentication-not-fresh',
});

export const commercePortalAuthMfaChallengeExpiredProblem = CommercePortalAuthMfaAuthenticationProblemSchema.make({
  code: 'mfa_challenge_expired',
  detail: 'The MFA challenge has expired.',
  status: problemStatus.authentication,
  title: 'MFA challenge expired',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-challenge-expired',
});

const commercePortalAuthMfaRejectedProblem = CommercePortalAuthMfaAuthenticationProblemSchema.make({
  code: 'mfa_rejected',
  detail: 'The MFA request was rejected.',
  status: problemStatus.authentication,
  title: 'MFA request rejected',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-rejected',
});

export const commercePortalAuthMfaUntrustedOriginProblem = CommercePortalAuthMfaForbiddenProblemSchema.make({
  code: 'origin_not_trusted',
  detail: 'Origin is not trusted for this authentication realm.',
  status: problemStatus.forbidden,
  title: 'MFA origin not trusted',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-origin-not-trusted',
});

/** The provider throttle code is the only provider-derived value allowed across the boundary. */
export const commercePortalAuthMfaRateLimitedProblem = (code: string) =>
  CommercePortalAuthMfaRateLimitedProblemSchema.make({
    code,
    detail: 'Too many MFA attempts. Retry later.',
    status: problemStatus.rateLimited,
    title: 'MFA rate limited',
    type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-rate-limited',
  });

export const commercePortalAuthMfaUnavailableProblem = CommercePortalAuthMfaUnavailableProblemSchema.make({
  code: 'authentication_unavailable',
  detail: 'Authentication provider is unavailable.',
  retryable: true,
  status: problemStatus.unavailable,
  title: 'MFA unavailable',
  type: 'https://ontos.dev/problems/commerce-portal-auth-mfa-unavailable',
});

/**
 * Provider outcomes keep the statuses the portal relied on: an expired challenge and a rejected
 * code stay 401, a throttle stays 429 carrying the provider code, and everything else is a
 * retryable 503. Only `INVALID_REQUEST` remains a 400, matching the replaced transport.
 */
export const commercePortalAuthMfaProblemForFailure = (
  failure: CommercePortalAuthMfaProviderFailure,
): CommercePortalAuthMfaProblem => {
  if (Schema.is(CommercePortalAuthMfaChallengeExpired)(failure)) {
    return commercePortalAuthMfaChallengeExpiredProblem;
  }
  if (Schema.is(CommercePortalAuthMfaRateLimited)(failure)) {
    return commercePortalAuthMfaRateLimitedProblem(failure.code);
  }
  if (Schema.is(CommercePortalAuthMfaProviderRejected)(failure)) {
    return failure.code === 'INVALID_REQUEST'
      ? commercePortalAuthMfaInvalidProblem
      : commercePortalAuthMfaRejectedProblem;
  }
  return commercePortalAuthMfaUnavailableProblem;
};

/**
 * `HttpApiBuilder`'s payload decoder answers a *raw* 415 `HttpServerResponse` on content-type
 * mismatch (`decodePayload` in `HttpApiBuilder.ts`) — a success value, not an `HttpApiSchemaError` —
 * so `layerSchemaErrorTransform`'s `Effect.catch` alone never sees it; this rewrites it to the same
 * Invalid problem, keeping every MFA answer `application/problem+json`.
 */
const rewriteUnsupportedContentType = (response: HttpServerResponse.HttpServerResponse) =>
  response.status === 415 ? Effect.fail(commercePortalAuthMfaInvalidProblem) : Effect.succeed(response);

/**
 * Built directly on `Layer.succeed` — the same primitive `HttpApiMiddleware.layerSchemaErrorTransform`
 * is built on — rather than on that helper, because it must also apply
 * `rewriteUnsupportedContentType` to the response channel, not only map `HttpApiSchemaError` (every
 * other schema failure: excess properties, malformed JSON, bad params) on the error channel. The
 * sibling step-up group carries the identical middleware.
 */
export const commercePortalAuthMfaSchemaErrorLive = Layer.succeed(
  CommercePortalAuthMfaSchemaErrorMiddleware,
  (httpEffect, _options) =>
    httpEffect.pipe(
      Effect.flatMap(rewriteUnsupportedContentType),
      Effect.catchIf(
        (error) => HttpApiError.HttpApiSchemaError.is(error),
        () => Effect.fail(commercePortalAuthMfaInvalidProblem),
      ),
    ),
);
