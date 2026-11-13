import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { customerOwnConsentReadApiLive, customerOwnConsentUpdateApiLive } from '../../api/portal-auth/consent/http.ts';
import { customerOwnPasswordChangeApiLive } from '../../api/portal-auth/password-change/http.ts';
import { customerOwnProfileReadApiLive, customerOwnProfileUpdateApiLive } from '../../api/portal-auth/profile/http.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import { CommerceCustomerAuthority } from '../../api/portal-auth/session/customer-authority.ts';
import { CommercePortalAuthService } from '../../api/portal-auth/session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle-service.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { CustomerOwnConsentReadApi, CustomerOwnConsentUpdateApi } from '../../shared/portal-auth/consent-api.ts';
import { CustomerOwnPasswordChangeApi } from '../../shared/portal-auth/password-change-api.ts';
import { CustomerOwnProfileReadApi, CustomerOwnProfileUpdateApi } from '../../shared/portal-auth/profile-api.ts';

/*
 * The five portal self-service routes admit a request only when BOTH the customer's session cookie and the registered
 * storefront client's own credential (its `Authorization` header) are present. A browser that holds the customer's
 * cookie but not the storefront's credential is answered 401 on every route, before anything is read or run.
 */

const ORIGIN = 'https://portal.example.test';
const COOKIE = 'commerce-portal.session_token=current';
const NOW = 1_800_000_000_000;
const at = (millis: number) => DateTime.toDate(DateTime.makeUnsafe(millis));

/** The five routes under one API of the module's own id, so the module's route groups serve it unchanged. */
const portalRoutesApi = HttpApi.make('CommerceCustomerContextApi')
  .addHttpApi(CustomerOwnConsentReadApi)
  .addHttpApi(CustomerOwnConsentUpdateApi)
  .addHttpApi(CustomerOwnPasswordChangeApi)
  .addHttpApi(CustomerOwnProfileReadApi)
  .addHttpApi(CustomerOwnProfileUpdateApi);

const CONFIG: CommercePortalAuthConfigValue = {
  baseUrl: ORIGIN,
  connectionString: Redacted.make('postgres://user:pass@localhost:5432/commerce'),
  nodeEnvironment: 'test',
  policy: COMMERCE_PORTAL_AUTH_POLICY,
  secret: Redacted.make('a'.repeat(32)),
  secureCookies: true,
  trustedOrigins: [ORIGIN],
  trustedProxies: [],
  versionedSecrets: [],
};

const reached: string[] = [];
/** Anything past admission: reaching it at all fails the test. */
const unreachable = (name: string) =>
  Schema.decodeUnknownSync(Schema.Any)(
    new Proxy(
      {},
      {
        get: () => () => {
          reached.push(name);
          return Effect.die(`${name} was reached without the storefront's credential`);
        },
      },
    ),
  );

const sessionReads: string[] = [];
const sessionRef = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:session-1`;
/** The customer's live session, exactly as the provider answers the cookie. */
const liveSession = {
  api: Schema.decodeUnknownSync(Schema.Any)({
    getSession: (input: { readonly headers: Headers }) => {
      sessionReads.push(input.headers.get('cookie') ?? '');
      return Promise.resolve({
        headers: new Headers(),
        response: {
          session: { createdAt: at(NOW - 60_000), expiresAt: at(NOW + 3_600_000), id: 'session-1' },
          user: { email: 'customer@example.test', id: 'commerce-user-1', name: 'Customer' },
        },
      });
    },
  }),
};
const sessionEvidence = Schema.decodeUnknownSync(Schema.Any)({
  evidenceForSession: () =>
    Effect.succeed({
      authenticatedAt: at(NOW - 60_000),
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      createdAt: at(NOW - 60_000),
      expiresAt: at(NOW + 3_600_000),
      policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
      providerSubjectId: 'commerce-user-1',
      sessionRef,
      subjectType: 'user',
      updatedAt: at(NOW - 60_000),
    }),
});

const portalApp = Effect.acquireRelease(
  Effect.sync(() =>
    HttpRouter.toWebHandler(
      HttpApiBuilder.layer(portalRoutesApi).pipe(
        Layer.provide(
          Layer.mergeAll(
            customerOwnConsentReadApiLive,
            customerOwnConsentUpdateApiLive,
            customerOwnPasswordChangeApiLive,
            customerOwnProfileReadApiLive,
            customerOwnProfileUpdateApiLive,
          ),
        ),
        Layer.provide(Layer.succeed(CommercePortalAuthService, liveSession)),
        Layer.provide(Layer.succeed(CommercePortalAuthSessionLifecycle, sessionEvidence)),
        Layer.provide(Layer.succeed(CommercePortalAuthConfig, CONFIG)),
        Layer.provide(Layer.succeed(CommerceCustomerAuthority, unreachable('customer authority'))),
        Layer.provide(Layer.succeed(ReadRuntime, unreachable('read runtime'))),
        Layer.provide(Layer.succeed(ActionRuntime, unreachable('action runtime'))),
        Layer.provide(Layer.succeed(GatewayAssertionRedemptionService, unreachable('assertion redemption'))),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    ),
  ),
  (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
);

const ROUTES = [
  ['GET', '/api/portal-auth/customer-profile', undefined],
  [
    'POST',
    '/api/portal-auth/customer-profile',
    { contactEmail: 'customer@example.test', displayName: 'Customer', phone: '+420777123456', version: 'a'.repeat(64) },
  ],
  ['GET', '/api/portal-auth/customer-consent', undefined],
  [
    'POST',
    '/api/portal-auth/customer-consent',
    {
      decision: 'WITHDRAWN',
      expectedRevision: 0,
      noticeAcknowledged: false,
      noticeVersionId: 'demo-newsletter.cs.v1',
      requestId: '50000000-0000-4000-8000-000000000001',
    },
  ],
  ['POST', '/api/portal-auth/change-password', { currentPassword: 'c'.repeat(16), newPassword: 'n'.repeat(16) }],
] as const;

it.effect("a session cookie without the storefront's credential is 401 on every portal route", () =>
  Effect.gen(function* cookieOnly() {
    const app = yield* portalApp;
    const requestContext = Context.makeUnsafe<unknown>(new Map());
    for (const [method, route, body] of ROUTES) {
      const headers = new Headers({ 'content-type': 'application/json', cookie: COOKIE, origin: ORIGIN });
      const request = new Request(
        `${ORIGIN}${route}`,
        body === undefined ? { headers, method } : { body: JSON.stringify(body), headers, method },
      );
      const response = yield* Effect.promise(() => app.handler(request, requestContext));
      const problem = yield* Effect.promise(() => response.json());
      expect({ code: problem.code, method, route, status: response.status }).toEqual({
        code: 'authentication_failed',
        method,
        route,
        status: 401,
      });
    }
    // Each route read the customer's live session from the cookie first: the 401 is the missing storefront credential.
    expect(sessionReads).toEqual(ROUTES.map(() => COOKIE));
    expect(reached).toEqual([]);
  }),
);
