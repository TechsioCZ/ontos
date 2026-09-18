import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  VerifyExternalAuthenticationRequestSchema,
  VerifyExternalAuthenticationResultSchema,
} from './portal-auth-contracts.ts';

/** Stable operation name shared with the lane05 provider service. */
export const COMMERCE_PORTAL_AUTH_VERIFY_OPERATION =
  'commerce-portal-authentication.verify-external-authentication.v1' as const;

const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/**
 * The provider verification route is a private workload boundary.  The operation
 * and receiving audience are carried in the signed/composed request context rather
 * than inferred from a customer credential.
 */
export const CommercePortalAuthVerificationRequestSchema = Schema.Struct({
  ...VerifyExternalAuthenticationRequestSchema.fields,
  audience: boundedReference,
  operation: Schema.Literal(COMMERCE_PORTAL_AUTH_VERIFY_OPERATION),
  operationRef: boundedReference,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthVerificationRequest = typeof CommercePortalAuthVerificationRequestSchema.Type;

export const CommercePortalAuthVerificationHeadersSchema = Schema.Struct({
  authorization: Schema.optionalKey(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
  ),
  'x-correlation-id': Schema.optionalKey(boundedReference),
});

export type CommercePortalAuthVerificationHeaders = typeof CommercePortalAuthVerificationHeadersSchema.Type;

export const CommercePortalAuthVerificationInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthVerificationInvalidProblem',
  400,
);
export const CommercePortalAuthVerificationUnauthorizedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthVerificationUnauthorizedProblem',
  401,
);
export const CommercePortalAuthVerificationForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthVerificationForbiddenProblem',
  403,
);
export const CommercePortalAuthVerificationUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthVerificationUnavailableProblem',
  503,
);

export const commercePortalAuthVerificationProblems = [
  CommercePortalAuthVerificationInvalidProblemSchema,
  CommercePortalAuthVerificationUnauthorizedProblemSchema,
  CommercePortalAuthVerificationForbiddenProblemSchema,
  CommercePortalAuthVerificationUnavailableProblemSchema,
] as const;

/**
 * Standalone API contract.  The root composition adds this API to its deployment
 * only when Commerce provider verification is installed.
 */
export const CommercePortalAuthVerificationApi = HttpApi.make('CommercePortalAuthVerificationApi').add(
  HttpApiGroup.make('externalAuthenticationVerification').add(
    HttpApiEndpoint.post('verifyExternalAuthentication', '/portal-auth/internal/verify', {
      error: commercePortalAuthVerificationProblems,
      headers: CommercePortalAuthVerificationHeadersSchema,
      payload: CommercePortalAuthVerificationRequestSchema,
      success: VerifyExternalAuthenticationResultSchema,
    }),
  ),
);

export type { VerifyExternalAuthenticationResult } from './portal-auth-contracts.ts';
