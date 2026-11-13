import { Config, Context, Crypto, Effect, Layer, Option, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

import { paymentNotificationRouteUnavailable } from '../../shared/actions/configure-provider-account-binding.ts';
import type { PaymentNotificationRouteUnavailableError } from '../../shared/actions/configure-provider-account-binding.ts';
import { ProviderBindingRouteKeySchema } from '../../shared/apis/provider-binding-route.ts';
import type { ProviderBindingRouteKey } from '../../shared/apis/provider-binding-route.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../shared/domain/psp-configuration.ts';
import type { GatewayHttpsUrl } from '../../shared/domain/psp-configuration.ts';
import { PAYMENT_GATEWAY_RELAY_PATH_PREFIX } from '../../shared/payment-gateway-relay.ts';

/**
 * Payment-owned notification routes (#1157, phase 2 D-P4, N11). Each Provider Account Binding gets a route key
 * of 32 cryptographically random bytes (unpadded base64url, 43 characters) and a notification URL Payment
 * builds from the deployment's public Shell origin:
 *
 *   `${ONTOS_PAYMENT_NOTIFICATION_BASE_URL}/api/payment/v1/notifications/<family>/<tenantId>/<routeKey>`
 *
 * The URL has no query string (GoPay appends `?id=`). The route key routes; it is not a credential. The
 * variable is read when a route is issued, never while the layers build: without a valid origin only binding
 * creation is refused (`payment_notification_route_unavailable`); the rest of Payment keeps running.
 */

export const PAYMENT_NOTIFICATION_BASE_URL_VARIABLE = 'ONTOS_PAYMENT_NOTIFICATION_BASE_URL';
const ROUTE_KEY_BYTES = 32;

/** A route issued for one new binding; stored together with the binding in the same transaction. */
export interface PaymentNotificationRoute {
  readonly notificationUrl: GatewayHttpsUrl;
  readonly routeKey: ProviderBindingRouteKey;
}

export interface PaymentNotificationRouteIssuer {
  readonly issue: (input: {
    readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
    readonly tenantId: string;
  }) => Effect.Effect<PaymentNotificationRoute, PaymentNotificationRouteUnavailableError>;
}

export class PaymentNotificationRoutes extends Context.Service<
  PaymentNotificationRoutes,
  PaymentNotificationRouteIssuer
>()('@app/payment/config/payment-notification-route-config/PaymentNotificationRoutes') {}

/**
 * The public origin only: `https`, a host, no credentials, path, query or fragment. A single trailing slash is
 * tolerated and dropped. Anything else is refused rather than repaired.
 */
export const parseNotificationOrigin = (raw: string): Option.Option<string> => {
  const trimmed = raw.trim();
  if (trimmed !== raw || !URL.canParse(raw)) {
    return Option.none();
  }
  const url = new URL(raw);
  const exact = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    exact.toLowerCase() === url.origin.toLowerCase()
    ? Option.some(url.origin)
    : Option.none();
};

/** The underlying failure travels as the non-enumerable native `cause`, never in the problem payload. */
const unavailable = (reason: string, cause?: unknown) => {
  const failure = paymentNotificationRouteUnavailable(reason);
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const readOrigin = Config.option(Config.String(PAYMENT_NOTIFICATION_BASE_URL_VARIABLE)).pipe(
  Effect.mapError((cause) => unavailable('The public notification origin of this deployment cannot be read', cause)),
  Effect.flatMap((configured) =>
    Effect.fromOption(configured).pipe(
      Effect.mapError((cause) => unavailable('This deployment configures no public notification origin', cause)),
    ),
  ),
  Effect.flatMap((raw) =>
    Effect.fromOption(parseNotificationOrigin(raw)).pipe(
      Effect.mapError((cause) =>
        unavailable('The configured public notification origin is not an https origin', cause),
      ),
    ),
  ),
);

const decodeRouteKey = Schema.decodeUnknownEffect(ProviderBindingRouteKeySchema);
const decodeNotificationUrl = Schema.decodeUnknownEffect(GatewayHttpsUrlSchema);

/** `<origin>/api/payment/v1/notifications/<family>/<tenantId>/<routeKey>`, without a query string. */
export const notificationUrlOf = (input: {
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly origin: string;
  readonly routeKey: ProviderBindingRouteKey;
  readonly tenantId: string;
}) =>
  `${input.origin}${PAYMENT_GATEWAY_RELAY_PATH_PREFIX}/notifications/${input.family.toLowerCase()}/${input.tenantId}/${input.routeKey}`;

const makeIssuer = (crypto: Crypto.Crypto): PaymentNotificationRouteIssuer => ({
  issue: Effect.fn('PaymentNotificationRoutes.issue')(function* issue({ family, tenantId }) {
    const origin = yield* readOrigin;
    const routeKey = yield* crypto.randomBytes(ROUTE_KEY_BYTES).pipe(
      Effect.flatMap((bytes) => decodeRouteKey(Base64Url.encode(bytes))),
      Effect.mapError((cause) => unavailable('No route key could be generated', cause)),
    );
    const notificationUrl = yield* decodeNotificationUrl(
      notificationUrlOf({ family, origin, routeKey, tenantId }),
    ).pipe(
      Effect.mapError((cause) => unavailable('The notification URL of the route is not a valid https URL', cause)),
    );
    return { notificationUrl, routeKey } satisfies PaymentNotificationRoute;
  }),
});

/** Production issuer over the composition's cryptographic random source. */
export const PaymentNotificationRoutesLive = Layer.effect(
  PaymentNotificationRoutes,
  Crypto.Crypto.pipe(Effect.map(makeIssuer)),
);
