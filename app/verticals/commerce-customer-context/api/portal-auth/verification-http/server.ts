import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';
import { CommercePortalAuthVerificationService } from '../provider/verification.ts';
import { CommercePortalAuthVerificationApi } from '../../../shared/portal-auth-verification.ts';
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

  const verification = yield* CommercePortalAuthVerificationService;
  return yield* verification.verifyExternalAuthentication(providerRequest(payload)).pipe(
    Effect.catchTags({
      CommercePortalAuthVerificationCallerRejected: providerRejectedProblem,
      CommercePortalAuthVerificationCallerUnavailable: providerUnavailableProblem,
      CommercePortalAuthVerificationInvalidRequest: providerInvalidProblem,
    }),
  );
});

/**
 * The standalone mount. The Commerce composition root cannot mount this group yet: the handler's
 * verifier requires `CommercePortalAuthVerificationCaller` and `CommerceEnrollmentProofService`,
 * neither of which has a production layer anywhere in this vertical — both exist only as test
 * doubles. Mounting it before those owner ports land would publish a route that can only answer
 * 503, so the route stays deployment-gated until they do.
 */
export const commercePortalAuthVerificationApiLive = HttpApiBuilder.group(
  CommercePortalAuthVerificationApi,
  'externalAuthenticationVerification',
  (handlers) => handlers.handle('verifyExternalAuthentication', ({ payload, request }) => execute(payload, request)),
);
