import { Context, Effect, Layer } from 'effect';
import type { Cause, Types } from 'effect';
import { HttpApiError } from 'effect/http-api';

import {
  PaymentGatewayHostMount,
  paymentNotificationInvalidProblem,
  paymentNotificationNotFoundProblem,
  paymentNotificationUnavailableProblem,
  paymentReconciliationInvalidProblem,
  paymentReconciliationNotFoundProblem,
  paymentReconciliationUnavailableProblem,
} from './contract.ts';
import { PaymentNotificationBoundary } from './notification-boundary.ts';
import { PaymentReconciliationBoundary } from './reconciliation-boundary.ts';

/**
 * Boundaries of both relay groups (#1157). Off the trusted relay mount every request is the group's 404;
 * schema failures become the declared invalid problem; a defect is logged with its reason classes only and
 * answered with the retryable 503. Request bodies, provider secrets, signatures, API keys and route keys
 * can sit in defect values and annotations, so none of them is ever logged or replied.
 */

/** Shell's one defect seam (`recoverUnexpectedDefect` in `api/index.ts`), bound to the relay's sanitizer. */
export class PaymentGatewayDefectSeam extends Context.Service<
  PaymentGatewayDefectSeam,
  {
    readonly recover: <Failure>(
      message: string,
      fail: () => Effect.Effect<never, Failure>,
    ) => <Value, Failed, Requirements>(
      effect: Effect.Effect<Value, Failed, Requirements>,
    ) => Effect.Effect<Value, Failed | Failure, Requirements>;
  }
>()('@app/shell-super-app/api/payment-gateway/defect-boundary/PaymentGatewayDefectSeam') {}

/** Keeps each reason's classification and nothing else. */
export const describePaymentGatewayDefect = (cause: Cause.Cause<unknown>) => ({
  reasons: cause.reasons.map((reason) => reason._tag),
});

export const PaymentNotificationBoundaryLive = Layer.effect(
  PaymentNotificationBoundary,
  Effect.gen(function* paymentNotificationBoundary() {
    const seam = yield* PaymentGatewayDefectSeam;
    return Effect.fn('PaymentNotificationBoundary.apply')(function* applyPaymentNotificationBoundary(operation) {
      if (!(yield* PaymentGatewayHostMount)) {
        return yield* Effect.fail(paymentNotificationNotFoundProblem);
      }
      return yield* operation.pipe(
        Effect.catch((error): Effect.Effect<never, typeof paymentNotificationInvalidProblem | Types.unhandled> =>
          HttpApiError.HttpApiSchemaError.is(error)
            ? Effect.fail(paymentNotificationInvalidProblem)
            : Effect.fail(error),
        ),
        seam.recover('Unexpected payment notification relay defect', () =>
          Effect.fail(paymentNotificationUnavailableProblem),
        ),
      );
    });
  }),
);

export const PaymentReconciliationBoundaryLive = Layer.effect(
  PaymentReconciliationBoundary,
  Effect.gen(function* paymentReconciliationBoundary() {
    const seam = yield* PaymentGatewayDefectSeam;
    return Effect.fn('PaymentReconciliationBoundary.apply')(function* applyPaymentReconciliationBoundary(operation) {
      if (!(yield* PaymentGatewayHostMount)) {
        return yield* Effect.fail(paymentReconciliationNotFoundProblem);
      }
      return yield* operation.pipe(
        Effect.catch((error): Effect.Effect<never, typeof paymentReconciliationInvalidProblem | Types.unhandled> =>
          HttpApiError.HttpApiSchemaError.is(error)
            ? Effect.fail(paymentReconciliationInvalidProblem)
            : Effect.fail(error),
        ),
        seam.recover('Unexpected payment reconciliation relay defect', () =>
          Effect.fail(paymentReconciliationUnavailableProblem),
        ),
      );
    });
  }),
);
