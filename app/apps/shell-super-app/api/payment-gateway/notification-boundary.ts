import {
  PaymentNotificationInvalidProblemSchema,
  PaymentNotificationNotFoundProblemSchema,
  PaymentNotificationUnavailableProblemSchema,
} from '@app/payment/payment-gateway-relay';
import { HttpApiMiddleware } from 'effect/http-api';

/**
 * Boundary of the PSP notification group (#1157): schema failures become the declared 400, a request off
 * the trusted relay mount the 404, and anything unexpected the retryable 503. No body byte, provider
 * secret or relay key ever reaches a reply.
 */
export class PaymentNotificationBoundary extends HttpApiMiddleware.Service<PaymentNotificationBoundary>()(
  '@app/shell-super-app/api/payment-gateway/notification-boundary/PaymentNotificationBoundary',
  {
    error: [
      PaymentNotificationInvalidProblemSchema,
      PaymentNotificationNotFoundProblemSchema,
      PaymentNotificationUnavailableProblemSchema,
    ],
  },
) {}
