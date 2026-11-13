import type { CaptureProviderNotificationPayloadSchema } from '@app/payment/api/capture-provider-notification-action';
import { executeCaptureProviderNotificationWithAuthorization } from '@app/payment/api/capture-provider-notification-action/client';
import type { ProviderBindingRouteResponse } from '@app/payment/api/provider-binding-route';
import { executeRequestPaymentOperationRecoveryWithAuthorization } from '@app/payment/api/request-payment-operation-recovery-action/client';
import {
  COMGATE_NOTIFICATION_ACKNOWLEDGED,
  PAYMENT_GATEWAY_RELAY_PATH_PREFIX,
  PAYMENT_NOTIFICATION_ACKNOWLEDGED,
  PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
  PaymentReconciliationConflictProblemSchema,
  PaymentReconciliationIneligibleProblemSchema,
} from '@app/payment/payment-gateway-relay';
import type { PaymentReconciliationRecoveryPayload } from '@app/payment/payment-gateway-relay';
import { makeProblemDetailsSchema, problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { useEffectContext } from '@modern-js/bff-effect/context';
import { HttpApiBuilder, HttpEffect } from '@modern-js/bff-effect/effect-edge';
import { Context, Crypto, Effect, Match, Option, Predicate, Redacted, Schema, Stream } from 'effect';
import type { Types } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { HttpMethod } from 'effect/http';
import { HttpApiError } from 'effect/http-api';

import { ShellAuthenticationApi } from '../../shared/api.ts';
import {
  PaymentGatewayHostMount,
  paymentNotificationInvalidProblem,
  paymentNotificationNotFoundProblem,
  paymentNotificationTooLargeProblem,
  paymentNotificationUnavailableProblem,
  paymentReconciliationAuthenticationProblem,
  paymentReconciliationForbiddenProblem,
  paymentReconciliationInvalidProblem,
  paymentReconciliationNotFoundProblem,
  paymentReconciliationUnavailableProblem,
} from './contract.ts';
import type { PaymentRouteAuthority, PaymentRouteAuthorizationInput, PaymentRouteRefused } from './contract.ts';
import { resolveNotificationRelayCredential } from './relay-credentials.ts';

/**
 * Shell transport of the Payment gateway relay (#1157, phase 2 D-P4/D-P5).
 *
 * Notifications: the exact request bytes, the allow-listed headers and the GoPay query reach Payment's
 * capture Action under a route-scoped assertion for exactly that Action. The PSP gets a 2xx only after
 * capture answered CAPTURED, DUPLICATE or IGNORED, which means the notification is durably recorded;
 * everything OntOS did not record is a retryable 503. Family, environment and account come only from the
 * protected route answer, never from the request.
 *
 * Reconciliation: one route-scoped A10 call per request with the caller's idempotency key unchanged; A10
 * refusals keep their codes. Paths outside the typed contract get a typed 404/405 and never reach a raw
 * handler.
 */

export class PaymentGatewayRelay extends Context.Service<
  PaymentGatewayRelay,
  {
    /** Fresh API key verification, route proof and route-scoped issuance for one HTTP attempt. */
    readonly authorize: (
      input: PaymentRouteAuthorizationInput,
    ) => Effect.Effect<PaymentRouteAuthority, PaymentRouteRefused, HttpServerRequest.HttpServerRequest>;
  }
>()('@app/shell-super-app/api/payment-gateway/transport/PaymentGatewayRelay') {}

type CaptureProviderNotificationPayload = typeof CaptureProviderNotificationPayloadSchema.Type;
type ProviderFamily = ProviderBindingRouteResponse['providerFamily'];

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

const noStoreHeaders = { 'cache-control': 'no-store' };
const respondNotFound = HttpServerResponse.schemaJson(PaymentGatewayRouteNotFoundProblemSchema)(routeNotFoundProblem, {
  contentType: problemDetailsContentType,
  headers: noStoreHeaders,
  status: routeNotFoundProblem.status,
}).pipe(Effect.orDie);
const respondMethodNotAllowed = (allowed: HttpMethod.HttpMethod) =>
  HttpServerResponse.schemaJson(PaymentGatewayMethodNotAllowedProblemSchema)(methodNotAllowedProblem, {
    contentType: problemDetailsContentType,
    headers: { ...noStoreHeaders, allow: allowed },
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

/**
 * Shell's API key resolution adds an API key challenge to a failed verification. A PSP never holds that
 * key, so a notification reply never names an authentication scheme.
 */
const dropApiKeyChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.removeHeader(response, 'www-authenticate')),
);

/** Logs only the failure class: failure values can carry assertions, provider data or request bytes. */
const failRelayCall =
  <Problem>(operation: string, problem: Problem) =>
  (failure: { readonly _tag: string }) =>
    Effect.annotateLogs(Effect.logWarning('Payment gateway relay call did not complete'), {
      failure: failure._tag,
      operation,
    }).pipe(Effect.andThen(Effect.fail(problem)));

const freshIdentifier = Effect.fn('PaymentGatewayRelay.freshIdentifier')(function* freshIdentifier() {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4();
});

const classifyBodyFailure = <Failure>(failure: Failure) =>
  HttpApiError.HttpApiPayloadTooLarge.is(failure)
    ? paymentNotificationTooLargeProblem
    : paymentNotificationUnavailableProblem;

/** Concatenates the received chunks into one `Uint8Array`; above the capture limit it is the 413. */
const concatenateBody = Effect.fn('PaymentNotificationRelay.concatenateBody')(function* concatenateBody(
  chunks: readonly Uint8Array[],
) {
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.length;
  }
  if (size > PAYMENT_NOTIFICATION_MAXIMUM_BYTES) {
    return yield* Effect.fail(paymentNotificationTooLargeProblem);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
});

/** The PSP body exactly as received, never decoded or re-encoded. */
const collectBody = <Failure>(body: Stream.Stream<Uint8Array, Failure>) =>
  Stream.runCollect(Stream.mapError(body, classifyBodyFailure)).pipe(Effect.flatMap(concatenateBody));

const isPresent = Schema.is(Schema.NonEmptyString);
type CapturedHeaders = CaptureProviderNotificationPayload['headers'];
type CapturedQuery = CaptureProviderNotificationPayload['query'];

/** Only non-empty allow-listed headers travel; capture refuses an empty value, so an empty one is omitted. */
const capturedHeaders = (received: {
  readonly 'content-type'?: string;
  readonly 'stripe-signature'?: string;
}): CapturedHeaders => {
  const headers: Types.Mutable<CapturedHeaders> = {};
  if (isPresent(received['content-type'])) {
    headers.contentType = received['content-type'];
  }
  if (isPresent(received['stripe-signature'])) {
    headers.stripeSignature = received['stripe-signature'];
  }
  return headers;
};
/** GoPay `id` is the payment reference and `parent_id` the parent payment reference. */
const capturedGopayQuery = (received: { readonly id?: string; readonly parent_id?: string }): CapturedQuery => {
  const query: Types.Mutable<CapturedQuery> = {};
  if (isPresent(received.id)) {
    query.paymentRef = received.id;
  }
  if (isPresent(received.parent_id)) {
    query.parentPaymentRef = received.parent_id;
  }
  return query;
};

interface ProviderNotification {
  readonly body: Effect.Effect<
    Uint8Array,
    typeof paymentNotificationTooLargeProblem | typeof paymentNotificationUnavailableProblem
  >;
  readonly family: ProviderFamily;
  readonly headers: CapturedHeaders;
  readonly query: CapturedQuery;
  readonly routeKey: PaymentRouteAuthorizationInput['routeKey'];
  readonly tenantId: string;
}

const notificationRefusal = (refusal: PaymentRouteRefused) =>
  Effect.fail(
    refusal.reason === 'not_found' ? paymentNotificationNotFoundProblem : paymentNotificationUnavailableProblem,
  );

/** One capture attempt: a fresh idempotency key and delivery reference, and route-owned binding facts only. */
const captureNotification = Effect.fn('PaymentNotificationRelay.capture')(function* capture(
  authority: PaymentRouteAuthority,
  notification: ProviderNotification,
  rawBody: Uint8Array,
) {
  const [idempotencyKey, transportDeliveryRef, requestCorrelation] = yield* Effect.all(
    [freshIdentifier(), freshIdentifier(), freshIdentifier()],
    { concurrency: 1 },
  ).pipe(Effect.catchTag('PlatformError', failRelayCall('identifier', paymentNotificationUnavailableProblem)));
  const payload: CaptureProviderNotificationPayload = {
    environment: authority.route.environment,
    family: authority.route.providerFamily,
    headers: notification.headers,
    providerAccountRef: authority.route.bindingRef,
    query: notification.query,
    rawBody,
    transportDeliveryRef,
  };
  return yield* executeCaptureProviderNotificationWithAuthorization(
    payload,
    `Bearer ${Redacted.value(authority.assertion)}`,
    requestCorrelation,
    { baseUrl: authority.baseUrl, compositionRevision: authority.compositionRevision, idempotencyKey },
  ).pipe(Effect.catch(failRelayCall('capture', paymentNotificationUnavailableProblem)));
});

const relayNotification = Effect.fn('PaymentNotificationRelay.relay')(function* relay(
  notification: ProviderNotification,
) {
  const rawBody = yield* notification.body;
  const apiKey = yield* resolveNotificationRelayCredential(notification.tenantId);
  if (Option.isNone(apiKey)) {
    return yield* Effect.fail(paymentNotificationNotFoundProblem);
  }
  const relayService = yield* PaymentGatewayRelay;
  const authority = yield* relayService
    .authorize({
      apiKey: apiKey.value,
      notificationPath: Option.some({ providerFamily: notification.family, tenantId: notification.tenantId }),
      routeKey: notification.routeKey,
      workload: 'payment.provider-notification-ingress',
    })
    .pipe(Effect.ensuring(dropApiKeyChallenge), Effect.catchTag('PaymentRouteRefused', notificationRefusal));
  const result = yield* captureNotification(authority, notification, rawBody);
  return yield* Match.value(result).pipe(
    Match.tagsExhaustive({
      CAPTURED: () => Effect.void,
      DUPLICATE: () => Effect.void,
      IGNORED: () => Effect.void,
      REJECTED: ({ reason }) =>
        Effect.fail(
          reason === 'BINDING_UNKNOWN' ? paymentNotificationNotFoundProblem : paymentNotificationInvalidProblem,
        ),
    }),
  );
});

const noBody = Effect.succeed(new Uint8Array(0));

export const PaymentNotificationHandlersLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'paymentNotifications',
  (group) =>
    group
      .handle('gopay', ({ params, query }) =>
        relayNotification({
          body: noBody,
          family: 'GOPAY',
          headers: {},
          query: capturedGopayQuery(query),
          routeKey: params.routeKey,
          tenantId: params.tenantId,
        }).pipe(Effect.as(PAYMENT_NOTIFICATION_ACKNOWLEDGED)),
      )
      .handle('stripe', ({ headers, params, payload }) =>
        relayNotification({
          body: collectBody(payload),
          family: 'STRIPE',
          headers: capturedHeaders(headers),
          query: {},
          routeKey: params.routeKey,
          tenantId: params.tenantId,
        }).pipe(Effect.as(PAYMENT_NOTIFICATION_ACKNOWLEDGED)),
      )
      .handle('comgate', ({ headers, params, payload }) =>
        relayNotification({
          body: collectBody(payload),
          family: 'COMGATE',
          headers: capturedHeaders(headers),
          query: {},
          routeKey: params.routeKey,
          tenantId: params.tenantId,
        }).pipe(Effect.as(COMGATE_NOTIFICATION_ACKNOWLEDGED)),
      ),
);

const reconciliationRefusal = (refusal: PaymentRouteRefused) =>
  Effect.fail(
    Match.value(refusal.reason).pipe(
      Match.withReturnType<
        | typeof paymentReconciliationAuthenticationProblem
        | typeof paymentReconciliationForbiddenProblem
        | typeof paymentReconciliationNotFoundProblem
        | typeof paymentReconciliationUnavailableProblem
      >(),
      Match.when('unauthenticated', () => paymentReconciliationAuthenticationProblem),
      Match.when('forbidden', () => paymentReconciliationForbiddenProblem),
      Match.when('not_found', () => paymentReconciliationNotFoundProblem),
      Match.when('unavailable', () => paymentReconciliationUnavailableProblem),
      Match.exhaustive,
    ),
  );

const reconciliationConflict = (code: (typeof PaymentReconciliationConflictProblemSchema.Type)['code']) =>
  PaymentReconciliationConflictProblemSchema.make({
    code,
    detail: 'The recovery request conflicts with the current state of the payment operation.',
    status: PaymentReconciliationConflictProblemSchema.fields.status.literal,
    title: 'Recovery request conflict',
    type: 'https://ontos.dev/problems/payment-reconciliation-conflict',
  });
const reconciliationIneligible = (code: (typeof PaymentReconciliationIneligibleProblemSchema.Type)['code']) =>
  PaymentReconciliationIneligibleProblemSchema.make({
    code,
    detail: 'The payment operation is not eligible for this recovery request.',
    status: PaymentReconciliationIneligibleProblemSchema.fields.status.literal,
    title: 'Recovery request not eligible',
    type: 'https://ontos.dev/problems/payment-reconciliation-ineligible',
  });

type RecoveryClientError = Effect.Error<ReturnType<typeof executeRequestPaymentOperationRecoveryWithAuthorization>>;

/**
 * A10 refusals keep their status and code. A malformed request is `request_invalid`; an A10 authentication
 * refusal of Shell's own assertion, an internal error, an indeterminate commit and every transport failure
 * are the retryable 503 (the driver retries in a later round, never within this request).
 */
const recoveryProblem = (error: RecoveryClientError) =>
  Match.value(error).pipe(
    Match.withReturnType<
      | typeof paymentReconciliationForbiddenProblem
      | typeof paymentReconciliationNotFoundProblem
      | typeof paymentReconciliationUnavailableProblem
      | typeof PaymentReconciliationConflictProblemSchema.Type
      | typeof PaymentReconciliationIneligibleProblemSchema.Type
    >(),
    Match.tag('RequestPaymentOperationRecoveryActionConflictProblem', ({ code }) => reconciliationConflict(code)),
    Match.tag('RequestPaymentOperationRecoveryActionAlreadyCommittedProblem', ({ code }) =>
      reconciliationConflict(code),
    ),
    Match.tag('RequestPaymentOperationRecoveryActionIneligibleProblem', ({ code }) => reconciliationIneligible(code)),
    Match.tag('RequestPaymentOperationRecoveryActionForbiddenProblem', () => paymentReconciliationForbiddenProblem),
    Match.tag('RequestPaymentOperationRecoveryActionNotFoundProblem', () => paymentReconciliationNotFoundProblem),
    Match.tag(
      'RequestPaymentOperationRecoveryActionInvalidProblem',
      'RequestPaymentOperationRecoveryActionPreconditionProblem',
      () => paymentReconciliationInvalidProblem,
    ),
    Match.orElse(() => paymentReconciliationUnavailableProblem),
  );

const requestRecovery = Effect.fn('PaymentReconciliationRelay.requestRecovery')(function* requestRecovery(input: {
  readonly apiKey: Redacted.Redacted;
  readonly idempotencyKey: string;
  readonly payload: PaymentReconciliationRecoveryPayload;
  readonly routeKey: PaymentRouteAuthorizationInput['routeKey'];
}) {
  const relayService = yield* PaymentGatewayRelay;
  const authority = yield* relayService
    .authorize({
      apiKey: input.apiKey,
      notificationPath: Option.none(),
      routeKey: input.routeKey,
      workload: 'payment.provider-reconciliation',
    })
    .pipe(Effect.catchTag('PaymentRouteRefused', reconciliationRefusal));
  const requestCorrelation = yield* freshIdentifier().pipe(
    Effect.catchTag('PlatformError', failRelayCall('identifier', paymentReconciliationUnavailableProblem)),
  );
  const result = yield* executeRequestPaymentOperationRecoveryWithAuthorization(
    input.payload,
    `Bearer ${Redacted.value(authority.assertion)}`,
    requestCorrelation,
    {
      baseUrl: authority.baseUrl,
      compositionRevision: authority.compositionRevision,
      idempotencyKey: input.idempotencyKey,
    },
  ).pipe(Effect.mapError(recoveryProblem));
  if (Predicate.isTagged(result, 'ActionProposalAccepted')) {
    // A parked proposal is not a recorded recovery; the driver principal never runs under approval.
    return yield* Effect.fail(paymentReconciliationForbiddenProblem);
  }
  return result;
});

export const PaymentReconciliationHandlersLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'paymentReconciliation',
  (group) =>
    group.handle('requestRecovery', ({ headers, params, payload }) =>
      requestRecovery({
        apiKey: Redacted.make(headers['x-api-key']),
        idempotencyKey: headers['idempotency-key'],
        payload,
        routeKey: params.routeKey,
      }),
    ),
);

// The fallback depends on the trusted host mount and emits only typed route errors.
export const PaymentGatewayRelayTransportLive = HttpRouter.add('*', '/api/payment/v1/*', (request) =>
  rejectedRoute(request),
);
