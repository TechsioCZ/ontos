import { ActionRuntime } from '@app/core-runtime';
import type { ActionExecutionResolution } from '@app/core-runtime';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted, Schema } from 'effect';
import { commerceCustomerContextApi } from '../shared/api.ts';
import { EnrollmentCommandRecoveryResultSchema } from '../shared/enrollment-command-recovery-api.ts';
import type { EnrollmentCommandRecoveryInputSchema } from '../shared/enrollment-command-recovery-api.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import {
  commercePortalAuthEnrollmentAuthenticationProblem,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentSchemaErrorLive,
  commercePortalAuthEnrollmentUnavailableProblem,
} from './portal-auth/enrollment/problems.ts';

/** Core retains the committed Action key; the published owner response exposes only its exact verdict. */
export const enrollmentCommandRecoveryResult = Effect.fn('EnrollmentCommandRecovery.publishResult')(
  function* publishResult(
    actionKey: typeof EnrollmentCommandRecoveryInputSchema.Type.actionKey,
    resolution: ActionExecutionResolution,
  ) {
    if (resolution.state === 'COMMITTED' && resolution.actionKey !== actionKey) {
      return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
    }
    const published =
      resolution.state === 'COMMITTED'
        ? {
            invocationId: resolution.invocationId,
            retryCommand: resolution.retryCommand,
            state: resolution.state,
          }
        : resolution;
    // This is an explicit Core-to-owner projection, not an excess-property decoding exemption.
    return yield* Schema.decodeUnknownEffect(EnrollmentCommandRecoveryResultSchema, { onExcessProperty: 'error' })(
      published,
    ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
  },
);

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
        const resolution = yield* runtime.resolveActionExecution({ ...payload, principal }).pipe(
          Effect.catchTags({
            ActionInvocationPersistenceError: () => Effect.fail(commercePortalAuthEnrollmentUnavailableProblem()),
            ActionPayloadValidationError: () => Effect.fail(commercePortalAuthEnrollmentInvalidProblem()),
            ActionTrustedContextValidationError: () => Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem),
          }),
        );
        return yield* enrollmentCommandRecoveryResult(payload.actionKey, resolution);
      }),
    ),
).pipe(Layer.provide(commercePortalAuthEnrollmentSchemaErrorLive));
