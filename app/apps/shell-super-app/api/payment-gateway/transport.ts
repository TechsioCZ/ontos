import {
  PAYMENT_GATEWAY_RELAY_PATH_PREFIX,
  PaymentNotificationInvalidProblemSchema,
  PaymentNotificationUnavailableProblemSchema,
  PaymentReconciliationIneligibleProblemSchema,
  PaymentReconciliationUnavailableProblemSchema,
} from '@app/payment/payment-gateway-relay';
import { makeProblemDetailsSchema, problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { useEffectContext } from '@modern-js/bff-effect/context';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Option } from 'effect';
import type { Types } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { HttpMethod } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

import { ShellAuthenticationApi } from '../../shared/api.ts';
import { PaymentNotificationBoundary } from './notification-boundary.ts';
import { PaymentReconciliationBoundary } from './reconciliation-boundary.ts';

/**
 * Shell transport of the Payment gateway relay (#1157, phase 2 D-P4/D-P5). Until the relay flow lands,
 * every typed endpoint fails closed with its retryable 503: nothing is captured, no recovery is
 * requested, and a PSP keeps retrying within its own limits. Paths outside the typed contract get a
 * typed 404/405 and never reach a raw handler.
 */

/** True only while a request runs under its restored, trusted original relay path. */
export const PaymentGatewayHostMount = Context.Reference<boolean>(
  '@app/shell-super-app/api/payment-gateway/transport/PaymentGatewayHostMount',
  { defaultValue: () => false },
);

const PaymentGatewayRouteNotFoundProblemSchema = makeProblemDetailsSchema('PaymentGatewayRouteNotFoundProblem', 404);
const PaymentGatewayMethodNotAllowedProblemSchema = makeProblemDetailsSchema(
  'PaymentGatewayMethodNotAllowedProblem',
  405,
);

const routeNotFoundProblem = PaymentGatewayRouteNotFoundProblemSchema.make({
  detail: 'The requested payment gateway route does not exist.',
  status: PaymentGatewayRouteNotFoundProblemSchema.fields.status.literal,
  title: 'Payment gateway route not found',
  type: 'https://ontos.dev/problems/payment-gateway-route-not-found',
});
const methodNotAllowedProblem = PaymentGatewayMethodNotAllowedProblemSchema.make({
  detail: 'This payment gateway path does not support the requested method.',
  status: PaymentGatewayMethodNotAllowedProblemSchema.fields.status.literal,
  title: 'Payment gateway method not allowed',
  type: 'https://ontos.dev/problems/payment-gateway-method-not-allowed',
});

export const paymentNotificationInvalidProblem = PaymentNotificationInvalidProblemSchema.make({
  detail: 'The provider notification does not match the declared notification contract.',
  status: PaymentNotificationInvalidProblemSchema.fields.status.literal,
  title: 'Invalid provider notification',
  type: 'https://ontos.dev/problems/payment-notification-invalid',
});
export const paymentNotificationUnavailableProblem = PaymentNotificationUnavailableProblemSchema.make({
  detail: 'The provider notification was not recorded; retry later.',
  retryable: true,
  status: PaymentNotificationUnavailableProblemSchema.fields.status.literal,
  title: 'Notification relay unavailable',
  type: 'https://ontos.dev/problems/payment-notification-unavailable',
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

const noStore = { 'cache-control': 'no-store' };
const respondNotFound = HttpServerResponse.schemaJson(PaymentGatewayRouteNotFoundProblemSchema)(routeNotFoundProblem, {
  contentType: problemDetailsContentType,
  headers: noStore,
  status: routeNotFoundProblem.status,
}).pipe(Effect.orDie);
const respondMethodNotAllowed = (allowed: HttpMethod.HttpMethod) =>
  HttpServerResponse.schemaJson(PaymentGatewayMethodNotAllowedProblemSchema)(methodNotAllowedProblem, {
    contentType: problemDetailsContentType,
    headers: { ...noStore, allow: allowed },
    status: methodNotAllowedProblem.status,
  }).pipe(Effect.orDie);

/** Path templates of the typed relay endpoints; `:name` segments match any single segment. */
const relayRouteTemplates: readonly { readonly method: HttpMethod.HttpMethod; readonly path: string }[] = [
  { method: 'GET', path: '/api/payment/v1/notifications/gopay/:tenantId/:routeKey' },
  { method: 'POST', path: '/api/payment/v1/notifications/stripe/:tenantId/:routeKey' },
  { method: 'POST', path: '/api/payment/v1/notifications/comgate/:tenantId/:routeKey' },
  { method: 'POST', path: '/api/payment/v1/reconciliation/:routeKey/recoveries' },
];
const relayRoutes = relayRouteTemplates.map(({ method, path }) => ({ method, segments: path.split('/') }));

const isRelayPath = (path: string): boolean =>
  path === PAYMENT_GATEWAY_RELAY_PATH_PREFIX || path.startsWith(`${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/`);

const rejectedRoute = Effect.fn('PaymentGatewayRelay.rejectRoute')(function* rejectPaymentGatewayRoute(
  request: HttpServerRequest.HttpServerRequest,
) {
  if (!(yield* PaymentGatewayHostMount)) {
    return yield* respondNotFound;
  }
  const segments = Option.getOrUndefined(HttpServerRequest.toURL(request))?.pathname.split('/');
  const route =
    segments === undefined
      ? undefined
      : relayRoutes.find(
          ({ segments: template }) =>
            template.length === segments.length &&
            template.every((segment, index) => segment === segments[index] || segment.startsWith(':')),
        );
  return yield* route === undefined || route.method === request.method
    ? respondNotFound
    : respondMethodNotAllowed(route.method);
});

/** Modern strips the active BFF mount. Restore only a trusted, original relay path before routing. */
export const PaymentGatewayHostMountLive = HttpRouter.middleware(
  Effect.fn('PaymentGatewayRelay.restoreMount')(function* restorePaymentGatewayMount(
    next: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  ) {
    const originalPath = Option.getOrUndefined(yield* Effect.option(Effect.try(() => useEffectContext().path)));
    const request = yield* HttpServerRequest.HttpServerRequest;
    const mountedUrl = Option.getOrUndefined(HttpServerRequest.toURL(request));
    if (originalPath !== undefined && isRelayPath(originalPath) && mountedUrl !== undefined) {
      if (
        originalPath.includes('//') ||
        originalPath.endsWith('/') ||
        originalPath.includes('%') ||
        originalPath.includes(';')
      ) {
        return yield* respondNotFound;
      }
      return yield* next.pipe(
        Effect.updateService(PaymentGatewayHostMount, () => true),
        Effect.updateService(HttpServerRequest.HttpServerRequest, (mounted) =>
          mounted.modify({ url: originalPath + mountedUrl.search }),
        ),
      );
    }
    if (mountedUrl !== undefined && isRelayPath(mountedUrl.pathname)) {
      return yield* respondNotFound;
    }
    return yield* next;
  }),
  { global: true },
);

const notificationUnavailable = () => Effect.fail(paymentNotificationUnavailableProblem);
const reconciliationUnavailable = () => Effect.fail(paymentReconciliationUnavailableProblem);

/** Fail-closed stubs: no notification is captured until the relay flow is wired. */
export const PaymentNotificationHandlersLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'paymentNotifications',
  (group) =>
    group
      .handle('gopay', notificationUnavailable)
      .handle('stripe', notificationUnavailable)
      .handle('comgate', notificationUnavailable),
);

/** Fail-closed stub: no recovery is requested until the reconciliation relay is wired. */
export const PaymentReconciliationHandlersLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'paymentReconciliation',
  (group) => group.handle('requestRecovery', reconciliationUnavailable),
);

/**
 * Boundary layers. The stub maps schema failures to each group's declared invalid problem; the declared
 * off-mount 404 and defect 503 of the same boundary are filled in by the relay flow.
 */
export const PaymentNotificationBoundaryLive = HttpApiMiddleware.layerSchemaErrorTransform(
  PaymentNotificationBoundary,
  () => Effect.fail(paymentNotificationInvalidProblem),
);
export const PaymentReconciliationBoundaryLive = HttpApiMiddleware.layerSchemaErrorTransform(
  PaymentReconciliationBoundary,
  () => Effect.fail(paymentReconciliationInvalidProblem),
);

// The fallback depends on the trusted host mount and emits only typed route errors.
export const PaymentGatewayRelayTransportLive = HttpRouter.add('*', '/api/payment/v1/*', (request) =>
  rejectedRoute(request),
);
