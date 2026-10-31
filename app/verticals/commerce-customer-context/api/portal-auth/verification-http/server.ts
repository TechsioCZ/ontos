import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect } from 'effect';
import type { HttpServerRequest } from 'effect/http';
import type { CommercePortalAuthVerificationService } from '../provider/verification.ts';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { CommercePortalAuthVerificationApi } from '../../../shared/portal-auth-verification.ts';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import type { VerifyExternalAuthenticationResult } from '../../../shared/portal-auth-contracts.ts';
import type { CommercePortalAuthVerificationWorkloadAuthorization } from './workload-authorization.ts';
import type {
  commercePortalAuthVerificationForbiddenProblem,
  commercePortalAuthVerificationInvalidProblem,
  commercePortalAuthVerificationUnauthorizedProblem,
  commercePortalAuthVerificationUnavailableProblem,
} from './problems.ts';

export {
  CommercePortalAuthVerificationWorkloadAuthorization,
  CommercePortalAuthVerificationWorkloadRejected,
  CommercePortalAuthVerificationWorkloadUnavailable,
} from './workload-authorization.ts';
export type {
  CommercePortalAuthVerificationWorkloadAuthorizationInput,
  CommercePortalAuthVerificationWorkloadAuthorizationService,
} from './workload-authorization.ts';

type WorkloadExecution = ReturnType<CommercePortalAuthVerificationWorkloadAuthorization['Service']['authorize']>;
type VerificationHttpFailure =
  | typeof commercePortalAuthVerificationForbiddenProblem
  | typeof commercePortalAuthVerificationInvalidProblem
  | typeof commercePortalAuthVerificationUnauthorizedProblem
  | typeof commercePortalAuthVerificationUnavailableProblem;

/** Owner-internal boundary; only the sanctioned root implements its complete workload gate. */
export class CommercePortalAuthVerificationHttpExecutor extends Context.Service<
  CommercePortalAuthVerificationHttpExecutor,
  {
    readonly execute: (
      payload: CommercePortalAuthVerificationRequest,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      VerifyExternalAuthenticationResult,
      VerificationHttpFailure,
      | Effect.Services<WorkloadExecution>
      | CommercePortalAuthVerificationWorkloadAuthorization
      | CommercePortalAuthVerificationService
    >;
  }
>()(
  '@app/commerce-customer-context/api/portal-auth/verification-http/server/CommercePortalAuthVerificationHttpExecutor',
) {}

const executeVerificationHttp = Effect.fn('CommercePortalAuthVerificationHttp.delegate')(function* delegate(
  payload: CommercePortalAuthVerificationRequest,
  request: HttpServerRequest.HttpServerRequest,
) {
  const executor = yield* CommercePortalAuthVerificationHttpExecutor;
  return yield* executor.execute(payload, request);
});

/** Standalone mounting is explicit; this group supplies neither authority nor a provider graph. */
export const commercePortalAuthVerificationApiLive = HttpApiBuilder.group(
  CommercePortalAuthVerificationApi,
  'externalAuthenticationVerification',
  (handlers) =>
    handlers.handle('verifyExternalAuthentication', ({ payload, request }) =>
      executeVerificationHttp(payload, request),
    ),
);

/** The production mount inside the Commerce API; the root installs the executor and its full gate. */
export const commercePortalAuthVerificationCommerceApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'externalAuthenticationVerification',
  (handlers) =>
    handlers.handle('verifyExternalAuthentication', ({ payload, request }) =>
      executeVerificationHttp(payload, request),
    ),
);
