import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PaymentNotificationRouteUnavailable } from '../../shared/actions/configure-provider-account-binding.ts';
import { ProviderBindingRouteKeySchema } from '../../shared/apis/provider-binding-route.ts';
import {
  parseNotificationOrigin,
  PaymentNotificationRoutes,
  PaymentNotificationRoutesLive,
} from '../../src/config/payment-notification-route-config.ts';

/**
 * #1157 / N11: Payment builds every binding's notification URL from the deployment's public Shell origin, the
 * provider family, the Tenant and a route key of 32 random bytes. A caller never supplies it, and a deployment
 * without a valid origin refuses only binding creation.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://shell.example.test';

/** The issuer reads the variable when a route is issued, from the configuration of the issuing request. */
const withConfiguration = (configuration: Readonly<Record<string, string>>) =>
  Layer.merge(
    Layer.provide(PaymentNotificationRoutesLive, NodeCrypto.layer),
    ConfigProvider.layer(ConfigProvider.fromUnknown(configuration)),
  );
const withBaseUrl = (value: Option.Option<string>) =>
  withConfiguration(
    Option.match(value, { onNone: () => ({}), onSome: (url) => ({ ONTOS_PAYMENT_NOTIFICATION_BASE_URL: url }) }),
  );

const issue = (value: Option.Option<string>, family: 'COMGATE' | 'GOPAY' | 'STRIPE' = 'GOPAY') =>
  PaymentNotificationRoutes.pipe(
    Effect.flatMap((routes) => routes.issue({ family, tenantId: TENANT_ID })),
    Effect.provide(withBaseUrl(value)),
  );

describe('#1157 Payment-owned notification routes', () => {
  it.effect('#1157 N11 the notification URL is owner-built from the origin, family, Tenant and route key', () =>
    Effect.gen(function* ownerBuiltUrl() {
      for (const family of ['GOPAY', 'STRIPE', 'COMGATE'] as const) {
        const route = yield* issue(Option.some(`${ORIGIN}/`), family);
        expect(Schema.is(ProviderBindingRouteKeySchema)(route.routeKey)).toBe(true);
        expect(route.routeKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(route.notificationUrl).toBe(
          `${ORIGIN}/api/payment/v1/notifications/${family.toLowerCase()}/${TENANT_ID}/${route.routeKey}`,
        );
        // GoPay appends `?id=`: the URL itself has no query string or fragment.
        expect(route.notificationUrl).not.toMatch(/[?#]/u);
      }
    }),
  );

  it.effect('#1157 every route key is fresh cryptographic randomness', () =>
    Effect.gen(function* freshKeys() {
      const keys = yield* Effect.forEach(Array.from({ length: 16 }), () => issue(Option.some(ORIGIN)), {
        concurrency: 1,
      });
      expect(new Set(keys.map((route) => route.routeKey)).size).toBe(16);
    }),
  );

  it.effect('#1157 a missing or invalid origin refuses only the route, as a typed unavailable failure', () =>
    Effect.gen(function* refusedOrigins() {
      for (const value of [
        Option.none(),
        ...[
          '',
          'http://shell.example.test',
          'https://shell.example.test/base',
          'https://shell.example.test/?x=1',
          'https://shell.example.test/#f',
          'https://user:pass@shell.example.test',
          ' https://shell.example.test',
          'not a url',
        ].map(Option.some),
      ]) {
        const failure = yield* issue(value).pipe(Effect.flip);
        expect(Schema.is(PaymentNotificationRouteUnavailable)(failure)).toBe(true);
        expect(failure.code).toBe('payment_notification_route_unavailable');
        expect(JSON.stringify(failure)).not.toContain('pass');
      }
    }),
  );

  it.effect('#1157 the layer builds without the variable', () =>
    Effect.gen(function* buildsWithoutVariable() {
      const routes = yield* PaymentNotificationRoutes.pipe(Effect.provide(withConfiguration({})));
      expect(Object.keys(routes)).toEqual(['issue']);
    }),
  );

  it('#1157 only an exact https origin is accepted', () => {
    expect(parseNotificationOrigin('https://shell.example.test')).toEqual(Option.some('https://shell.example.test'));
    expect(parseNotificationOrigin('https://shell.example.test:8443/')).toEqual(
      Option.some('https://shell.example.test:8443'),
    );
    expect(Option.isNone(parseNotificationOrigin('https://shell.example.test//'))).toBe(true);
    expect(Option.isNone(parseNotificationOrigin('ftp://shell.example.test'))).toBe(true);
  });
});
