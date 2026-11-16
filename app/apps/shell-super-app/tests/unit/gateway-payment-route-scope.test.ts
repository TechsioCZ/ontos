import { LegalEntityContext, LegalEntityContextInactiveError } from '@app/core-runtime';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PROVIDER_BINDING_ROUTE_OPERATIONS } from '@app/payment/api/provider-binding-route';
import { DateTime, Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose';

import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import {
  acquirePaymentRouteScopeProof,
  issuePaymentRouteScopeAssertion,
  readPaymentRouteScope,
} from '../../api/auth/gateway-payment-route-scope.ts';
import type { PaymentRouteWorkload } from '../../api/auth/gateway-payment-route-scope.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

const compositionRevision = 'a'.repeat(64);
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-api-key:native-relay-key',
  authenticationNamespaceId: 'test.integration.better-auth.v1',
  authMethod: 'api_key' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const bindingId = '70000000-0000-4000-8000-000000000001';
const routeKey = 'R'.repeat(43);
const otherTenant = '90000000-0000-4000-8000-000000000001';
const route = {
  bindingId,
  bindingRef: `pab_${'0'.repeat(32)}`,
  bindingStatus: 'CURRENT',
  environment: 'SANDBOX',
  legalEntityId,
  operations: PROVIDER_BINDING_ROUTE_OPERATIONS,
  providerFamily: 'STRIPE',
  routeRevision: 3,
  tenantId: principal.tenantId,
};
const notificationRequest = {
  compositionRevision,
  notificationPath: Option.some({ providerFamily: 'STRIPE' as const, tenantId: principal.tenantId }),
  principal,
  requestCorrelation: 'payment-route-proof-test',
  routeKey,
  workload: 'payment.provider-notification-ingress' as const,
};
const reconciliationRequest = {
  ...notificationRequest,
  notificationPath: Option.none(),
  workload: 'payment.provider-reconciliation' as const,
};
const routeWorkloads = ['payment.provider-notification-ingress', 'payment.provider-reconciliation'];

interface FixtureOptions {
  /** Workloads the scripted native identity read finds active for the principal. */
  readonly activeWorkloads?: readonly PaymentRouteWorkload[] | readonly string[];
  readonly companyInactive?: boolean;
  readonly ownerResponse?: Response;
  readonly routeOverride?: Partial<typeof route>;
}

const fixture = Effect.fn('PaymentRouteScopeTest.fixture')(function* fixture(options: FixtureOptions = {}) {
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const jwk = yield* Effect.promise(() => exportJWK(privateKey));
  const calls: { readonly authorization: string | null; readonly body: string; readonly url: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    calls.push({
      authorization: incoming.headers.get('authorization'),
      body: await incoming.text(),
      url: incoming.url,
    });
    return options.ownerResponse ?? Response.json({ ...route, ...options.routeOverride });
  };
  const workloads = options.activeWorkloads ?? [
    'payment.provider-notification-ingress',
    'payment.provider-reconciliation',
    'payment.source-ingress',
  ];
  const connection = testSqlConnection((statement, parameters) => {
    const requested = routeWorkloads.find((workload) => parameters.includes(workload));
    return Effect.succeed(
      statement.includes('from core.principals p') &&
        parameters.includes(principal.authBindingId) &&
        parameters.includes('native-relay-key') &&
        parameters.includes(principal.authenticationNamespaceId) &&
        parameters.includes('payment.source-ingress') &&
        requested !== undefined &&
        workloads.includes(requested) &&
        workloads.includes('payment.source-ingress')
        ? [{ principal_id: principal.principalId }]
        : [],
    );
  });
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
  );
  let jti = 0;
  const issuer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(1_700_000_000),
    generateJti: Effect.sync(() => {
      jti += 1;
      return `60000000-0000-4000-8000-${String(jti).padStart(12, '0')}`;
    }),
    loadAdmission: Effect.succeed({
      audiences: new Map([['payment', 'native-payment-build']]),
      revision: compositionRevision,
    }),
    loadConfig: Effect.succeed({
      issuer: 'https://shell.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: jwk.d ?? '',
        kid: 'payment-route-test',
        kty: 'OKP',
        use: 'sig',
        x: jwk.x ?? '',
      },
    }),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  const company = Layer.succeed(LegalEntityContext, {
    listActiveForTenant: () => Effect.succeed([{ legalEntityId, legalName: 'Route company' }]),
    validateSelection: (tenant, companyId) =>
      options.companyInactive === true || tenant !== principal.tenantId || companyId !== legalEntityId
        ? Effect.fail(new LegalEntityContextInactiveError())
        : Effect.succeed({ legalEntityId, legalName: 'Route company' }),
  });
  return {
    calls,
    layer: Layer.mergeAll(database, issuer, company, Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
    publicKey,
  };
});

const verify = (token: string, publicKey: CryptoKey) =>
  Effect.promise(() =>
    jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
      audience: 'payment',
      currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
      issuer: 'https://shell.test',
    }),
  );

it.effect('reads the binding route as the integration principal and signs exactly the capture operation', () =>
  Effect.gen(function* notificationRouteScope() {
    const current = yield* fixture();
    const issued = yield* Effect.gen(function* acquireAndIssue() {
      const proof = yield* acquirePaymentRouteScopeProof(notificationRequest);
      expect((yield* readPaymentRouteScope(proof)).bindingId).toBe(bindingId);
      return yield* issuePaymentRouteScopeAssertion(proof, { principal });
    }).pipe(Effect.provide(current.layer));
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]?.url).toBe(
      'https://payment-owner-relay.invalid/module-api/payment/native-payment-build/payment-api/reads/provider-binding-route',
    );
    expect(JSON.parse(current.calls[0]?.body ?? '{}')).toEqual({ routeKey });
    const readClaims = decodeJwt((current.calls[0]?.authorization ?? '').slice('Bearer '.length));
    expect(readClaims.aud).toBe('payment');
    expect(readClaims).not.toHaveProperty('routeScope');
    expect(readClaims).not.toHaveProperty('legalEntityId');
    const verified = yield* verify(issued.assertion.token, current.publicKey);
    expect(verified.payload['routeScope']).toEqual({
      legalEntityId,
      operations: [{ entrypointKey: 'payment.core.capture-provider-notification', schemaVersion: '1' }],
      principalId: principal.principalId,
      routeId: bindingId,
      routeKey: 'provider-binding-route',
      routeRevision: '3',
      sourceRouteId: bindingId,
      sourceRouteRevision: '3',
      tenantId: principal.tenantId,
    });
    expect(issued.route.environment).toBe('SANDBOX');
    expect(issued.route.bindingRef).toBe(route.bindingRef);
  }),
);

it.effect('signs only operation recovery for the reconciliation workload, with a fresh JTI per invocation', () =>
  Effect.gen(function* reconciliationRouteScope() {
    const current = yield* fixture();
    const issue = Effect.gen(function* acquireAndIssue() {
      const proof = yield* acquirePaymentRouteScopeProof(reconciliationRequest);
      return yield* issuePaymentRouteScopeAssertion(proof, { principal });
    }).pipe(Effect.provide(current.layer));
    const first = yield* issue;
    const second = yield* issue;
    const [firstClaims, secondClaims] = yield* Effect.all(
      [verify(first.assertion.token, current.publicKey), verify(second.assertion.token, current.publicKey)],
      { concurrency: 2 },
    );
    expect(firstClaims.payload['routeScope']).toMatchObject({
      operations: [{ entrypointKey: 'payment.core.request-payment-operation-recovery', schemaVersion: '1' }],
    });
    expect(firstClaims.payload.jti).not.toBe(secondClaims.payload.jti);
  }),
);

it.effect('refuses a principal without the requested route workload or the Payment source workload', () =>
  Effect.gen(function* workloadControls() {
    const notificationOnly = yield* fixture({
      activeWorkloads: ['payment.provider-notification-ingress', 'payment.source-ingress'],
    });
    const wrongWorkload = yield* acquirePaymentRouteScopeProof(reconciliationRequest).pipe(
      Effect.flip,
      Effect.provide(notificationOnly.layer),
    );
    expect(wrongWorkload.code).toBe('forbidden');
    expect(notificationOnly.calls).toHaveLength(0);
    const sourceless = yield* fixture({ activeWorkloads: ['payment.provider-notification-ingress'] });
    const withoutSource = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(sourceless.layer),
    );
    expect(withoutSource.code).toBe('forbidden');
    expect(sourceless.calls).toHaveLength(0);
  }),
);

it.effect('refuses a tenant mismatch between the path, the key principal and the route answer', () =>
  Effect.gen(function* tenantControls() {
    const current = yield* fixture();
    const pathMismatch = yield* acquirePaymentRouteScopeProof({
      ...notificationRequest,
      notificationPath: Option.some({ providerFamily: 'STRIPE' as const, tenantId: otherTenant }),
    }).pipe(Effect.flip, Effect.provide(current.layer));
    expect(pathMismatch.code).toBe('forbidden');
    expect(current.calls).toHaveLength(0);
    const foreignRoute = yield* fixture({ routeOverride: { tenantId: otherTenant } });
    const routeMismatch = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(foreignRoute.layer),
    );
    expect(routeMismatch.code).toBe('forbidden');
  }),
);

it.effect('answers an unknown route and a route of another provider family as the same not_found', () =>
  Effect.gen(function* notFoundControls() {
    const otherFamily = yield* fixture({ routeOverride: { providerFamily: 'GOPAY' } });
    const familyMismatch = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(otherFamily.layer),
    );
    expect(familyMismatch.code).toBe('not_found');
    const unknown = yield* fixture({
      ownerResponse: Response.json(
        {
          _tag: 'ProviderBindingRouteNotFoundProblem',
          detail: 'No route.',
          status: 404,
          title: 'Not found',
          type: 'https://ontos.dev/problems/not-found',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 404 },
      ),
    });
    const unknownRoute = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(unknown.layer),
    );
    expect(unknownRoute.code).toBe('not_found');
    const malformedKey = yield* acquirePaymentRouteScopeProof({ ...notificationRequest, routeKey: 'short' }).pipe(
      Effect.flip,
      Effect.provide(unknown.layer),
    );
    expect(malformedKey.code).toBe('not_found');
  }),
);

it.effect('refuses an inactive Legal Entity and a Read that is unavailable', () =>
  Effect.gen(function* companyAndAvailability() {
    const inactive = yield* fixture({ companyInactive: true });
    const inactiveFailure = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(inactive.layer),
    );
    expect(inactiveFailure.code).toBe('forbidden');
    const down = yield* fixture({
      ownerResponse: Response.json(
        {
          _tag: 'ProviderBindingRouteUnavailableProblem',
          detail: 'Down.',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'https://ontos.dev/problems/unavailable',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 503 },
      ),
    });
    const unavailable = yield* acquirePaymentRouteScopeProof(notificationRequest).pipe(
      Effect.flip,
      Effect.provide(down.layer),
    );
    expect(unavailable.code).toBe('unavailable');
  }),
);

it.effect('refuses reflected or copied proofs and a different principal at issuance', () =>
  Effect.gen(function* proofControls() {
    const current = yield* fixture();
    yield* Effect.gen(function* inspectProof() {
      const proof = yield* acquirePaymentRouteScopeProof(notificationRequest);
      const reflected = Reflect.construct(proof.constructor, [{}, { routeJson: JSON.stringify(route) }]);
      expect((yield* Effect.flip(readPaymentRouteScope(reflected))).code).toBe('forbidden');
      const copied = Object.assign(Object.create(Object.getPrototypeOf(proof)), proof);
      expect((yield* Effect.flip(readPaymentRouteScope(copied))).code).toBe('forbidden');
      const otherPrincipal = yield* Effect.flip(
        issuePaymentRouteScopeAssertion(proof, {
          principal: { ...principal, principalId: '40000000-0000-4000-8000-000000000002' },
        }),
      );
      expect(otherPrincipal.code).toBe('forbidden');
    }).pipe(Effect.provide(current.layer));
  }),
);
