import { Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { jsonBody } from '../support/response.ts';

/**
 * The Commerce portal realm is optional. The Node and workerd artifact proofs build this vertical
 * with no `COMMERCE_PORTAL_AUTH_*` and no Resend transport, and while the provider layers were
 * composed unconditionally they could not be built there — which, because the assembled handler
 * Layer ends in `Layer.orDie`, turned every route into a 500, readiness included.
 *
 * This assembles the real composition root with the realm a host that opted out gets, and pins the
 * accepted posture: readiness and the governed business routes serve, and the portal routes fail
 * closed with the owner's retryable 503 problem rather than being absent, open, or a defect.
 */
const ORIGIN = 'http://localhost:3020';

const unconfiguredRuntime = Effect.acquireRelease(
  Effect.sync(() =>
    makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive,
      productionActionRuntimeLive,
      GatewayAssertionRedemptionLive,
      commercePortalAuthRealmUnavailableLive([ORIGIN]),
      Layer.empty,
    ).createHandler(),
  ),
  (runtime) => Effect.promise(async () => await runtime.dispose()),
);

type CommerceApiHandler = Effect.Success<typeof unconfiguredRuntime>;

const send = (runtime: CommerceApiHandler, request: Request) =>
  Effect.promise(async () => await runtime.handler(request));

it.effect('serves readiness and business routes with no Commerce portal realm installed', () =>
  Effect.scoped(
    Effect.gen(function* optionalRealmComposition() {
      const runtime = yield* unconfiguredRuntime;

      const readiness = yield* send(runtime, new Request(`${ORIGIN}/commerce-customer-context/readiness`));
      expect(readiness.status).toBe(200);
      expect(yield* jsonBody(readiness)).toMatchObject({
        checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready', translations: 'ready' },
        status: 'ready',
        versionSkew: 'none',
      });

      // A contract-valid governed read: reaching the handler is the point, so the answer is the
      // read's own declared problem rather than the router's schema rejection.
      const businessRead = yield* send(
        runtime,
        new Request(`${ORIGIN}/reads/saved-address-list`, {
          body: JSON.stringify({
            profile: {
              kind: 'RETAIL',
              profileRef: {
                moduleId: 'commerce.customer-context',
                resourceId: '11111111-1111-4111-8111-111111111111',
                resourceType: 'commerce.customer-context.retail-customer-profile',
                tenantId: '22222222-2222-4222-8222-222222222222',
              },
            },
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(businessRead.status).toBe(400);
      expect(businessRead.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* jsonBody(businessRead)).toMatchObject({
        status: 400,
        type: 'https://ontos.dev/problems/read-invalid',
      });
    }),
  ),
);

it.effect('fails the portal-auth routes closed with the retryable unavailable problem', () =>
  Effect.scoped(
    Effect.gen(function* failClosedPortalRoutes() {
      const runtime = yield* unconfiguredRuntime;

      const session = yield* send(runtime, new Request(`${ORIGIN}/api/portal-auth/get-session`));
      expect(session.status).toBe(503);
      expect(session.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* jsonBody(session)).toMatchObject({
        code: 'authentication_unavailable',
        retryable: true,
        status: 503,
      });

      const refresh = yield* send(
        runtime,
        new Request(`${ORIGIN}/api/portal-auth/refresh`, {
          body: '{}',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          method: 'POST',
        }),
      );
      expect(refresh.status).toBe(503);
      expect(yield* jsonBody(refresh)).toMatchObject({ retryable: true, status: 503 });
    }),
  ),
);
