import {
  PaymentReconciliationIneligibleProblemSchema,
  PaymentReconciliationNotFoundProblemSchema,
  PaymentReconciliationUnavailableProblemSchema,
} from '@app/payment/payment-gateway-relay';
import { HttpApiMiddleware } from 'effect/http-api';

/**
 * Boundary of the reconciliation driver group (#1157): schema failures become the declared 422
 * `request_invalid`, a request off the trusted relay mount the 404, and anything unexpected the
 * retryable 503. No API key or payload ever reaches a reply.
 */
export class PaymentReconciliationBoundary extends HttpApiMiddleware.Service<PaymentReconciliationBoundary>()(
  '@app/shell-super-app/api/payment-gateway/reconciliation-boundary/PaymentReconciliationBoundary',
  {
    error: [
      PaymentReconciliationIneligibleProblemSchema,
      PaymentReconciliationNotFoundProblemSchema,
      PaymentReconciliationUnavailableProblemSchema,
    ],
  },
) {}
