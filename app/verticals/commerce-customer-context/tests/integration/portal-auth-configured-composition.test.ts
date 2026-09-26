import { randomUUID } from 'node:crypto';

import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { Config, Effect, Layer, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { jsonBody } from '../support/response.ts';

/**
 * The other half of the optional realm: a host that opted in must get the installed provider, not
 * the fail-closed leaf. The composition root is assembled with a complete realm configuration
 * against the migrated `commerce_auth` schema, and the public sign-in route is exercised. An
 * unknown account answers the session group's own authentication problem — a response only
 * reachable once the durable attempt budget, the provider database and Better Auth were all built
 * for real.
 */
const ORIGIN = 'http://localhost:3020';
const SECRET = 'c'.repeat(64);

const providerDatabaseUrl = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

const configuredRuntime = Effect.acquireRelease(
  Effect.gen(function* buildConfiguredRuntime() {
    const databaseUrl = yield* providerDatabaseUrl;
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
      COMMERCE_PORTAL_AUTH_SECRET: SECRET,
      COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
    });
    // The transactional email transport is a required input of the provider graph; a rejected
    // sign-in never reaches delivery.
    const emailDeliveryConfiguration = Layer.succeed(ResendEmailDeliveryConfig, {
      apiKey: Redacted.make('re_commerce_portal_auth_composition_test'),
      endpoint: 'https://api.resend.com/emails',
      from: 'no-reply@commerce.example.test',
    });
    return makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive,
      productionActionRuntimeLive,
      GatewayAssertionRedemptionLive,
      commercePortalAuthRealmLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
        ),
      ),
      Layer.empty,
    ).createHandler();
  }),
  (runtime) => Effect.promise(async () => await runtime.dispose()),
);

it.effect('mounts the live portal-auth sign-in route when the realm is configured', () =>
  Effect.scoped(
    Effect.gen(function* configuredRealmComposition() {
      const runtime = yield* configuredRuntime;

      const signIn = yield* Effect.promise(
        async () =>
          await runtime.handler(
            new Request(`${ORIGIN}/api/portal-auth/sign-in/email`, {
              body: JSON.stringify({
                email: `absent-${randomUUID()}@composition.example.test`,
                password: 'P'.repeat(24),
              }),
              headers: { 'content-type': 'application/json', origin: ORIGIN },
              method: 'POST',
            }),
          ),
      );

      expect(signIn.status).toBe(401);
      expect(signIn.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* jsonBody(signIn)).toMatchObject({
        code: 'authentication_failed',
        status: 401,
        type: 'https://ontos.dev/problems/commerce-portal-auth-session-authentication',
      });
    }),
  ),
);
