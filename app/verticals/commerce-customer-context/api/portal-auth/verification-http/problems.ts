import {
  CommercePortalAuthVerificationForbiddenProblemSchema,
  CommercePortalAuthVerificationInvalidProblemSchema,
  CommercePortalAuthVerificationUnavailableProblemSchema,
  CommercePortalAuthVerificationUnauthorizedProblemSchema,
} from '../../../shared/portal-auth-verification.ts';

const problemStatus = {
  forbidden: 403,
  invalid: 400,
  unauthorized: 401,
  unavailable: 503,
} as const;

export const commercePortalAuthVerificationInvalidProblem = CommercePortalAuthVerificationInvalidProblemSchema.make({
  detail: 'The provider verification request is invalid.',
  status: problemStatus.invalid,
  title: 'Invalid provider verification request',
  type: 'https://ontos.dev/problems/commerce-portal-auth-verification-invalid',
});

export const commercePortalAuthVerificationUnauthorizedProblem =
  CommercePortalAuthVerificationUnauthorizedProblemSchema.make({
    detail: 'A trusted workload credential is required.',
    status: problemStatus.unauthorized,
    title: 'Provider verification authentication required',
    type: 'https://ontos.dev/problems/commerce-portal-auth-verification-unauthorized',
  });

export const commercePortalAuthVerificationForbiddenProblem = CommercePortalAuthVerificationForbiddenProblemSchema.make(
  {
    detail: 'The workload is not authorized for this exact provider verification request.',
    status: problemStatus.forbidden,
    title: 'Provider verification forbidden',
    type: 'https://ontos.dev/problems/commerce-portal-auth-verification-forbidden',
  },
);

export const commercePortalAuthVerificationUnavailableProblem =
  CommercePortalAuthVerificationUnavailableProblemSchema.make({
    detail: 'Provider verification is temporarily unavailable.',
    retryable: true,
    status: problemStatus.unavailable,
    title: 'Provider verification unavailable',
    type: 'https://ontos.dev/problems/commerce-portal-auth-verification-unavailable',
  });
