import {
  COMGATE_NOTIFICATION_ACKNOWLEDGED,
  ComgateNotificationHeadersSchema,
  GopayNotificationQuerySchema,
  PAYMENT_NOTIFICATION_ACKNOWLEDGED,
  PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
  PaymentNotificationInvalidProblemSchema,
  PaymentNotificationNotFoundProblemSchema,
  PaymentNotificationParamsSchema,
  PaymentNotificationUnavailableProblemSchema,
  StripeNotificationHeadersSchema,
} from '@app/payment/payment-gateway-relay';
import { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, Schema } from '@modern-js/bff-effect/effect-client';
import { OpenApi } from 'effect/http-api';

/**
 * PSP notification group of the Payment gateway relay (#1157, phase 2 D-P4). Payment owns the params,
 * headers, query and problems; Shell adds the transport encodings: the exact request bytes as a capped
 * stream and the plain-text acknowledgements each provider expects.
 */

/** Exact Stripe event bytes; the signature covers the raw body, so it is never decoded or re-encoded. */
const StripeNotificationBodySchema = HttpApiSchema.StreamUint8Array({
  contentType: 'application/json',
  maxBytes: PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
});
/** Exact Comgate push bytes: form-encoded for v1.0-created payments, JSON for v2.0. */
const ComgateNotificationBodySchema = HttpApiSchema.StreamUint8Array({
  contentType: ['application/x-www-form-urlencoded', 'application/json'],
  maxBytes: PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
});

const PaymentNotificationAcknowledgedSchema = Schema.Literal(PAYMENT_NOTIFICATION_ACKNOWLEDGED).pipe(
  HttpApiSchema.asText(),
);
const ComgateNotificationAcknowledgedSchema = Schema.Literal(COMGATE_NOTIFICATION_ACKNOWLEDGED).pipe(
  HttpApiSchema.asText({ contentType: 'application/x-www-form-urlencoded' }),
);

/**
 * Body above the captured-notification limit. `ProblemDetailsStatus` has no 413, so this one schema is
 * spelled out with the same Problem Details representation the shared factory produces.
 */
export const PaymentNotificationTooLargeProblemSchema = Schema.TaggedStruct('PaymentNotificationTooLargeProblem', {
  detail: Schema.String,
  status: Schema.Literal(413),
  title: Schema.String,
  type: Schema.String,
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(413));

const notificationErrors = [
  PaymentNotificationInvalidProblemSchema,
  PaymentNotificationNotFoundProblemSchema,
  PaymentNotificationTooLargeProblemSchema,
  PaymentNotificationUnavailableProblemSchema,
] as const;

const gopayNotificationEndpoint = HttpApiEndpoint.get(
  'gopay',
  '/api/payment/v1/notifications/gopay/:tenantId/:routeKey',
  {
    error: notificationErrors,
    params: PaymentNotificationParamsSchema,
    query: GopayNotificationQuerySchema,
    success: PaymentNotificationAcknowledgedSchema,
  },
);
const stripeNotificationEndpoint = HttpApiEndpoint.post(
  'stripe',
  '/api/payment/v1/notifications/stripe/:tenantId/:routeKey',
  {
    error: notificationErrors,
    headers: StripeNotificationHeadersSchema,
    params: PaymentNotificationParamsSchema,
    payload: StripeNotificationBodySchema,
    success: PaymentNotificationAcknowledgedSchema,
  },
);
const comgateNotificationEndpoint = HttpApiEndpoint.post(
  'comgate',
  '/api/payment/v1/notifications/comgate/:tenantId/:routeKey',
  {
    error: notificationErrors,
    headers: ComgateNotificationHeadersSchema,
    params: PaymentNotificationParamsSchema,
    payload: ComgateNotificationBodySchema,
    success: ComgateNotificationAcknowledgedSchema,
  },
);

/**
 * PSP-facing notification relay: no OntOS credential, exact bytes, one endpoint per provider family.
 * Shell attaches its boundary middleware, which maps schema failures to the 400 and defects to the 503.
 */
export const PaymentNotificationsGroup = HttpApiGroup.make('paymentNotifications')
  // Provider callbacks are not part of Shell's callable OpenAPI surface.
  .annotate(OpenApi.Exclude, true)
  .add(gopayNotificationEndpoint, stripeNotificationEndpoint, comgateNotificationEndpoint);
