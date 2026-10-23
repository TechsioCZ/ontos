import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted, Schema } from 'effect';
import { CommercePortalAuthVerificationCaller } from '../provider/verification-caller-service.ts';
import { CommercePortalAuthVerificationCallerRejected } from '../provider/verification-caller-rejected.ts';
import { VerifyExternalAuthenticationRequestSchema } from '../../../shared/portal-auth-contracts.ts';
import type { HttpServerRequest } from 'effect/unstable/http';
import { CommercePortalAuthVerificationService } from '../provider/verification.ts';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import {
  CommercePortalAuthVerificationApi,
  COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
} from '../../../shared/portal-auth-verification.ts';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import {
  commercePortalAuthVerificationForbiddenProblem,
  commercePortalAuthVerificationInvalidProblem,
  commercePortalAuthVerificationUnauthorizedProblem,
  commercePortalAuthVerificationUnavailableProblem,
} from './problems.ts';
import { CommercePortalAuthVerificationWorkloadAuthorization } from './workload-authorization.ts';

export {
  CommercePortalAuthVerificationWorkloadAuthorization,
  CommercePortalAuthVerificationWorkloadRejected,
  CommercePortalAuthVerificationWorkloadUnavailable,
} from './workload-authorization.ts';
export type {
  CommercePortalAuthVerificationWorkloadAuthorizationInput,
  CommercePortalAuthVerificationWorkloadAuthorizationService,
} from './workload-authorization.ts';

const workloadRejectedProblem = () => Effect.fail(commercePortalAuthVerificationForbiddenProblem);
const workloadUnavailableProblem = () => Effect.fail(commercePortalAuthVerificationUnavailableProblem);
const providerInvalidProblem = () => Effect.fail(commercePortalAuthVerificationInvalidProblem);
const providerRejectedProblem = () => Effect.fail(commercePortalAuthVerificationForbiddenProblem);
const providerUnavailableProblem = () => Effect.fail(commercePortalAuthVerificationUnavailableProblem);

const providerRequest = (request: CommercePortalAuthVerificationRequest) => {
  const base = {
    authenticationNamespaceId: request.authenticationNamespaceId,
    nonce: request.nonce,
    providerSubjectId: request.providerSubjectId,
    sessionRef: request.sessionRef,
    subjectType: request.subjectType,
    tenantId: request.tenantId,
  };
  return request.enrollmentAttemptId === undefined
    ? base
    : { ...base, enrollmentAttemptId: request.enrollmentAttemptId };
};

const sameVerifiedRequest = Schema.toEquivalence(VerifyExternalAuthenticationRequestSchema);

const execute = Effect.fn('CommercePortalAuthVerificationHttp.execute')(function* execute(
  payload: CommercePortalAuthVerificationRequest,
  request: HttpServerRequest.HttpServerRequest,
) {
  if (request.headers['authorization'] === undefined) {
    return yield* Effect.fail(commercePortalAuthVerificationUnauthorizedProblem);
  }
  const authority = yield* CommercePortalAuthVerificationWorkloadAuthorization;
  yield* authority
    .authorize({
      authorization: Redacted.make(request.headers['authorization']),
      request: payload,
      requestCorrelation: request.headers['x-correlation-id'],
    })
    .pipe(
      Effect.catchTags({
        CommercePortalAuthVerificationWorkloadRejected: workloadRejectedProblem,
        CommercePortalAuthVerificationWorkloadUnavailable: workloadUnavailableProblem,
      }),
    );

  // Only the request that passed live gateway redemption and exact workload grants may reach
  // provider state. This delegation is request-local and cannot authorize another subject or nonce.
  const admitted = providerRequest(payload);
  const caller: CommercePortalAuthVerificationCaller['Service'] = {
    authorize: (input) =>
      input.operation === COMMERCE_PORTAL_AUTH_VERIFY_OPERATION && sameVerifiedRequest(input, admitted)
        ? Effect.void
        : Effect.fail(
            new CommercePortalAuthVerificationCallerRejected({ reason: 'The verified workload request changed' }),
          ),
  };
  const verification = yield* CommercePortalAuthVerificationService;
  return yield* verification.verifyExternalAuthentication(admitted).pipe(
    // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The trusted HTTP boundary delegates only its redeemed, exact request; authority must not be global.
    Effect.provideService(CommercePortalAuthVerificationCaller, caller),
    Effect.catchTags({
      CommercePortalAuthVerificationCallerRejected: providerRejectedProblem,
      CommercePortalAuthVerificationCallerUnavailable: providerUnavailableProblem,
      CommercePortalAuthVerificationInvalidRequest: providerInvalidProblem,
    }),
  );
});

/** The root mounts this private group with the provider reader and durable owner Attempt proof. */
export const commercePortalAuthVerificationApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'externalAuthenticationVerification',
  (handlers) => handlers.handle('verifyExternalAuthentication', ({ payload, request }) => execute(payload, request)),
);

export const commercePortalAuthVerificationStandaloneApiLive = HttpApiBuilder.group(
  CommercePortalAuthVerificationApi,
  'externalAuthenticationVerification',
  (handlers) => handlers.handle('verifyExternalAuthentication', ({ payload, request }) => execute(payload, request)),
);
