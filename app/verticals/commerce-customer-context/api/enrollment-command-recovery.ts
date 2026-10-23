import { ActionRuntime } from '@app/core-runtime';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted } from 'effect';
import { commerceCustomerContextApi } from '../shared/api.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import {
  commercePortalAuthEnrollmentAuthenticationProblem,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentSchemaErrorLive,
  commercePortalAuthEnrollmentUnavailableProblem,
} from './portal-auth/enrollment/problems.ts';

/** Native lookup is restricted to the redeemed caller's Tenant, company and Principal. */
export const enrollmentCommandRecoveryLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'enrollmentCommandRecovery',
  (handlers) =>
    handlers.handle(
      'resolve',
      Effect.fn('EnrollmentCommandRecovery.resolve')(function* resolveCommand({ payload, request }) {
        const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
          authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
          unavailable: commercePortalAuthEnrollmentUnavailableProblem,
        });
        const runtime = yield* ActionRuntime;
        return yield* runtime.resolveActionExecution({ ...payload, principal }).pipe(
          Effect.catchTags({
            ActionInvocationPersistenceError: () => Effect.fail(commercePortalAuthEnrollmentUnavailableProblem()),
            ActionPayloadValidationError: () => Effect.fail(commercePortalAuthEnrollmentInvalidProblem()),
            ActionTrustedContextValidationError: () => Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem),
          }),
        );
      }),
    ),
).pipe(Layer.provide(commercePortalAuthEnrollmentSchemaErrorLive));
