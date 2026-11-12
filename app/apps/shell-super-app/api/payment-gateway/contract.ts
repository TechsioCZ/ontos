import type { ProviderBindingRouteKey, ProviderBindingRouteResponse } from '@app/payment/api/provider-binding-route';
import {
  PaymentNotificationInvalidProblemSchema,
  PaymentNotificationNotFoundProblemSchema,
  PaymentNotificationUnavailableProblemSchema,
  PaymentReconciliationAuthenticationProblemSchema,
  PaymentReconciliationForbiddenProblemSchema,
  PaymentReconciliationIneligibleProblemSchema,
  PaymentReconciliationNotFoundProblemSchema,
  PaymentReconciliationUnavailableProblemSchema,
} from '@app/payment/payment-gateway-relay';
import { Context, Effect, Schema } from 'effect';
import type { Option, Redacted } from 'effect';

import type { PaymentNotificationPath, PaymentRouteWorkload } from '../auth/gateway-payment-route-scope.ts';
import { PaymentNotificationTooLargeProblemSchema } from './notification-contract.ts';

/**
 * Shell side of the Payment gateway relay (#1157, phase 2 D-P4/D-P5): the fixed problem values every relay
 * reply uses and the request-local route authority the handlers consume. No problem ever carries a body
 * byte, a provider secret, a signature, an API key or a route key.
 */

/** True only while a request runs under its restored, trusted original relay path. */
export const PaymentGatewayHostMount = Context.Reference<boolean>(
  '@app/shell-super-app/api/payment-gateway/transport/PaymentGatewayHostMount',
  { defaultValue: () => false },
);

export const paymentNotificationInvalidProblem = PaymentNotificationInvalidProblemSchema.make({
  detail: 'The provider notification was not accepted.',
  status: PaymentNotificationInvalidProblemSchema.fields.status.literal,
  title: 'Invalid provider notification',
  type: 'https://ontos.dev/problems/payment-notification-invalid',
});
export const paymentNotificationNotFoundProblem = PaymentNotificationNotFoundProblemSchema.make({
  detail: 'The requested payment notification route does not exist.',
  status: PaymentNotificationNotFoundProblemSchema.fields.status.literal,
  title: 'Payment notification route not found',
  type: 'https://ontos.dev/problems/payment-notification-not-found',
});
export const paymentNotificationTooLargeProblem = PaymentNotificationTooLargeProblemSchema.make({
  detail: 'The provider notification body exceeds the accepted size.',
  status: PaymentNotificationTooLargeProblemSchema.fields.status.literal,
  title: 'Provider notification too large',
  type: 'https://ontos.dev/problems/payment-notification-too-large',
});
export const paymentNotificationUnavailableProblem = PaymentNotificationUnavailableProblemSchema.make({
  detail: 'The provider notification was not recorded; retry later.',
  retryable: true,
  status: PaymentNotificationUnavailableProblemSchema.fields.status.literal,
  title: 'Notification relay unavailable',
  type: 'https://ontos.dev/problems/payment-notification-unavailable',
});

export const paymentReconciliationAuthenticationProblem = PaymentReconciliationAuthenticationProblemSchema.make({
  detail: 'A valid reconciliation API key is required.',
  status: PaymentReconciliationAuthenticationProblemSchema.fields.status.literal,
  title: 'Reconciliation authentication required',
  type: 'https://ontos.dev/problems/payment-reconciliation-authentication-required',
});
export const paymentReconciliationForbiddenProblem = PaymentReconciliationForbiddenProblemSchema.make({
  detail: 'The reconciliation principal cannot request this recovery.',
  status: PaymentReconciliationForbiddenProblemSchema.fields.status.literal,
  title: 'Reconciliation forbidden',
  type: 'https://ontos.dev/problems/payment-reconciliation-forbidden',
});
export const paymentReconciliationNotFoundProblem = PaymentReconciliationNotFoundProblemSchema.make({
  detail: 'The requested payment reconciliation route does not exist.',
  status: PaymentReconciliationNotFoundProblemSchema.fields.status.literal,
  title: 'Payment reconciliation route not found',
  type: 'https://ontos.dev/problems/payment-reconciliation-not-found',
});
export const paymentReconciliationInvalidProblem = PaymentReconciliationIneligibleProblemSchema.make({
  code: 'request_invalid',
  detail: 'The reconciliation request does not match the declared contract.',
  status: PaymentReconciliationIneligibleProblemSchema.fields.status.literal,
  title: 'Invalid reconciliation request',
  type: 'https://ontos.dev/problems/payment-reconciliation-invalid',
});
export const paymentReconciliationUnavailableProblem = PaymentReconciliationUnavailableProblemSchema.make({
  detail: 'The recovery request was not recorded; retry in a later round.',
  retryable: true,
  status: PaymentReconciliationUnavailableProblemSchema.fields.status.literal,
  title: 'Reconciliation relay unavailable',
  type: 'https://ontos.dev/problems/payment-reconciliation-unavailable',
});

/** Why the relay could not obtain route authority; the handlers map it to their group's problems. */
const PaymentRouteRefusedSchema = Schema.TaggedStruct('PaymentRouteRefused', {
  reason: Schema.Literals(['unauthenticated', 'forbidden', 'not_found', 'unavailable']),
});
export type PaymentRouteRefused = typeof PaymentRouteRefusedSchema.Type;
export const paymentRouteRefused = (reason: PaymentRouteRefused['reason']) =>
  Effect.fail(PaymentRouteRefusedSchema.make({ reason }));

/** Request-local authority for one Payment operation of one binding route. */
export interface PaymentRouteAuthority {
  /** Route-scoped Bearer assertion naming exactly the one operation of the requested workload. */
  readonly assertion: Redacted.Redacted;
  /** The in-process Payment release relay base the generated clients call. */
  readonly baseUrl: URL;
  readonly compositionRevision: string;
  /** The protected route answer: tenant, Legal Entity, binding, family, environment and account ref. */
  readonly route: ProviderBindingRouteResponse;
}

export interface PaymentRouteAuthorizationInput {
  /** Relay credential (notifications) or the caller's `x-api-key` (reconciliation); verified fresh. */
  readonly apiKey: Redacted.Redacted;
  /** Notifications only: the Tenant and provider family the notification path names. */
  readonly notificationPath: Option.Option<PaymentNotificationPath>;
  readonly routeKey: ProviderBindingRouteKey;
  readonly workload: PaymentRouteWorkload;
}
