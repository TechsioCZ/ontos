import { ExternalIdentityVerificationRequestSchema } from '@app/core-runtime/auth/external-identity-provider';
import type { OntosExternalIdentityProviderInput } from '@app/core-runtime/auth/external-identity-provider';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  COMMERCE_ADMISSION_DEADLINE_MS,
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  VerifyExternalAuthenticationRequestSchema,
  VerifyExternalAuthenticationResultSchema,
} from './portal-auth-contracts.ts';

/** Stable operation name shared with the lane05 provider service. */
export const COMMERCE_PORTAL_AUTH_VERIFY_OPERATION =
  'commerce-portal-authentication.verify-external-authentication.v1' as const;

/** Private verification route on this module's BFF, relative to `/commerce-customer-context-api`. */
export const COMMERCE_PORTAL_AUTH_VERIFY_PATH = '/portal-auth/internal/verify' as const;

/** The external identity provider this module declares in its contract; the Shell calls it generically.
 * `provider` is the name the Shell records on the Auth Bindings it reserves for this namespace. */
export const commercePortalExternalIdentityProvider = {
  admissionDeadlineMs: COMMERCE_ADMISSION_DEADLINE_MS,
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  provider: 'better-auth',
  verification: { operation: COMMERCE_PORTAL_AUTH_VERIFY_OPERATION, path: COMMERCE_PORTAL_AUTH_VERIFY_PATH },
} as const satisfies OntosExternalIdentityProviderInput;

const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/**
 * The provider verification route is a private workload boundary.  The operation
 * and receiving audience are carried in the signed/composed request context rather
 * than inferred from a customer credential.  It narrows Core's generic external
 * identity verification request to this module's namespace, session and operation.
 */
export const CommercePortalAuthVerificationRequestSchema = Schema.Struct({
  ...ExternalIdentityVerificationRequestSchema.fields,
  ...VerifyExternalAuthenticationRequestSchema.fields,
  audience: boundedReference,
  operation: Schema.Literal(COMMERCE_PORTAL_AUTH_VERIFY_OPERATION),
  operationRef: boundedReference,
});

export type CommercePortalAuthVerificationRequest = typeof CommercePortalAuthVerificationRequestSchema.Type;

/** HTTP metadata is open; the two authority headers retain their own codecs. */
export const CommercePortalAuthVerificationHeadersSchema = Schema.StructWithRest(
  Schema.Struct({
    authorization: Schema.optionalKey(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
    ),
    'x-correlation-id': Schema.optionalKey(boundedReference),
  }),
  [
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^(?!(?:authorization|x-correlation-id)$).+/u)),
      Schema.Union([Schema.String, Schema.Redacted(Schema.String)]),
    ),
  ],
);

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
