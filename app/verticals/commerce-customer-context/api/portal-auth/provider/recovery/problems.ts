import { Effect, HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';

import {
  CommercePortalAuthRecoveryForbiddenProblemSchema,
  CommercePortalAuthRecoveryInvalidProblemSchema,
  CommercePortalAuthRecoveryRateLimitedProblemSchema,
  CommercePortalAuthRecoveryRejectedProblemSchema,
  CommercePortalAuthRecoverySchemaErrorMiddleware,
  CommercePortalAuthRecoveryUnavailableProblemSchema,
} from '../../../../shared/portal-auth/recovery-api.ts';

const problemStatus = {
  forbidden: 403,
  invalid: 400,
  rateLimited: 429,
  rejected: 400,
  unavailable: 503,
} as const;

export const commercePortalAuthRecoveryInvalidProblem = CommercePortalAuthRecoveryInvalidProblemSchema.make({
  code: 'invalid_request',
  detail: 'The authentication request is invalid.',
  status: problemStatus.invalid,
  title: 'Invalid recovery request',
  type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-invalid',
});

export const commercePortalAuthRecoveryUntrustedOriginProblem = CommercePortalAuthRecoveryForbiddenProblemSchema.make({
  code: 'origin_not_trusted',
  detail: 'Origin is not trusted for this authentication realm.',
  status: problemStatus.forbidden,
  title: 'Recovery origin not trusted',
  type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-origin-not-trusted',
});

export const commercePortalAuthRecoveryInvalidCallbackProblem = CommercePortalAuthRecoveryForbiddenProblemSchema.make({
  code: 'invalid_callback_url',
  detail: 'The reset callback URL is not trusted.',
  status: problemStatus.forbidden,
  title: 'Recovery callback URL not trusted',
  type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-invalid-callback-url',
});

export const commercePortalAuthRecoveryRateLimitedProblem = CommercePortalAuthRecoveryRateLimitedProblemSchema.make({
  code: 'rate_limited',
  detail: 'Too many recovery attempts. Retry later.',
  status: problemStatus.rateLimited,
  title: 'Recovery rate limited',
  type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-rate-limited',
});

export const commercePortalAuthRecoveryUnavailableProblem = CommercePortalAuthRecoveryUnavailableProblemSchema.make({
  code: 'authentication_unavailable',
  detail: 'Authentication provider is unavailable.',
  retryable: true,
  status: problemStatus.unavailable,
  title: 'Recovery unavailable',
  type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-unavailable',
});

/** The owner rejection code is the only provider-derived value allowed across the boundary. */
export const commercePortalAuthRecoveryRejectedProblem = (code: string) =>
  CommercePortalAuthRecoveryRejectedProblemSchema.make({
    code,
    detail: 'The authentication provider rejected the recovery request.',
    status: problemStatus.rejected,
    title: 'Recovery request rejected',
    type: 'https://ontos.dev/problems/commerce-portal-auth-recovery-rejected',
  });

export const commercePortalAuthRecoverySchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  CommercePortalAuthRecoverySchemaErrorMiddleware,
  () => Effect.fail(commercePortalAuthRecoveryInvalidProblem),
);
