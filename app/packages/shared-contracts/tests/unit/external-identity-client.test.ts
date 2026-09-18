// @effect-diagnostics strictEffectProvide:off -- Test-owned transport layers are the entrypoint for this client proof; expires: 2026-12-31.
import {
  ActivatePrincipalBindingRequestSchema,
  ChangePrincipalBindingStatusRequestSchema,
  ExternalGatewayContextRequestSchema,
  ExternalIdentityApi,
  ExternalIdentityForbiddenProblemSchema,
  ExternalIdentityUnavailableProblemSchema,
  ResolveExternalSubjectRequestSchema,
  ReservePrincipalBindingRequestSchema,
} from '../../src/external-identity.ts';
import {
  ActivatePrincipalBindingResultSchema,
  ChangePrincipalBindingStatusResultSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
  ResolveExternalSubjectResultSchema,
  ReservePrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  activatePrincipalBinding,
  changePrincipalBindingStatus,
  issueExternalGatewayContext,
  readPrincipalBinding,
  resolveExternalSubject,
  reservePrincipalBinding,
  externalIdentityTransportLayer,
} from '../../src/external-identity-client.ts';
import { GatewayContextResponseSchema } from '../../src/gateway-context.ts';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

const baseUrl = 'https://fixture.ontos.test/shell-super-app-api';
const shellApiPrefix = '/shell-super-app-api';
const apiKey = Redacted.make('dedicated-external-identity-key');
const requestCorrelation = 'external-identity-client-correlation';
const idempotencyKey = 'external-identity-client-idempotency';

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: S['Encoded']): S['Type'] =>
  Schema.decodeSync(schema)(input);

const reserveRequest = decode(ReservePrincipalBindingRequestSchema, {
  authenticationRef: 'commerce-admission-reference-1',
  reservation: {
    authenticationNamespaceId: 'commerce-customer',
    displayName: 'Ada Lovelace',
    providerSubjectId: 'provider-user-1',
    subjectType: 'user',
  },
});
const reserveResult = decode(ReservePrincipalBindingResultSchema, {
  authBindingId: '70000000-0000-4000-8000-000000000001',
  bindingRevision: 1,
  bindingStatus: 'pending',
  outcome: 'RESERVED',
  principalId: '40000000-0000-4000-8000-000000000001',
});
const activateRequest = decode(ActivatePrincipalBindingRequestSchema, {
  activation: {
    authBindingId: reserveResult.authBindingId,
    expectedRevision: reserveResult.bindingRevision,
  },
  authenticationRef: 'commerce-admission-reference-2',
});
const activateResult = decode(ActivatePrincipalBindingResultSchema, {
  authBindingId: reserveResult.authBindingId,
  bindingRevision: 2,
  bindingStatus: 'active',
  outcome: 'ACTIVATED',
  principalId: reserveResult.principalId,
});
const statusRequest = decode(ChangePrincipalBindingStatusRequestSchema, {
  authenticationRef: 'commerce-admission-reference-3',
  change: {
    authBindingId: reserveResult.authBindingId,
    expectedRevision: activateResult.bindingRevision,
    reason: 'Administrative test transition',
    requestedStatus: 'disabled',
  },
});
const statusResult = decode(ChangePrincipalBindingStatusResultSchema, {
  authBindingId: reserveResult.authBindingId,
  bindingRevision: 3,
  bindingStatus: 'disabled',
  previousStatus: 'active',
  principalId: reserveResult.principalId,
  transitionRef: '80000000-0000-4000-8000-000000000001',
});
const readRequest = decode(ReadPrincipalBindingPayloadSchema, {
  authBindingId: reserveResult.authBindingId,
  lookup: 'binding',
});
const readResult = decode(ReadPrincipalBindingResultSchema, {
  authBindingId: reserveResult.authBindingId,
  authenticationNamespaceId: reserveRequest.reservation.authenticationNamespaceId,
  bindingRevision: statusResult.bindingRevision,
  bindingStatus: statusResult.bindingStatus,
  originalInvocationId: null,
  outcome: 'FOUND',
  principalId: reserveResult.principalId,
  principalStatus: 'active',
  tenantStatus: 'active',
});
const resolveRequest = decode(ResolveExternalSubjectRequestSchema, {
  authenticationNamespaceId: reserveRequest.reservation.authenticationNamespaceId,
  authenticationRef: 'commerce-admission-reference-4',
  providerSubjectId: reserveRequest.reservation.providerSubjectId,
  subjectType: reserveRequest.reservation.subjectType,
});
const resolveResult = decode(ResolveExternalSubjectResultSchema, {
  authBindingId: reserveResult.authBindingId,
  authenticationNamespaceId: resolveRequest.authenticationNamespaceId,
  bindingRevision: statusResult.bindingRevision,
  bindingStatus: 'active',
  outcome: 'RESOLVED',
  principalId: reserveResult.principalId,
  tenantId: '30000000-0000-4000-8000-000000000001',
});
const gatewayRequest = decode(ExternalGatewayContextRequestSchema, {
  audience: 'commerce-customer-context',
  authenticationNamespaceId: resolveRequest.authenticationNamespaceId,
  authenticationRef: 'commerce-admission-reference-5',
  providerSubjectId: resolveRequest.providerSubjectId,
  subjectType: resolveRequest.subjectType,
});
const gatewayResult = decode(GatewayContextResponseSchema, {
  expiresAt: 1_700_000_300,
  token: 'fresh-gateway-context-token',
});

const fixtureHandlers = HttpApiBuilder.group(ExternalIdentityApi, 'externalIdentity', (handlers) =>
  handlers
    .handle('reservePrincipalBinding', () => Effect.succeed(reserveResult))
    .handle('activatePrincipalBinding', () => Effect.succeed(activateResult))
    .handle('changePrincipalBindingStatus', () => Effect.succeed(statusResult))
    .handle('readPrincipalBinding', () => Effect.succeed(readResult))
    .handle('resolveExternalSubject', () => Effect.succeed(resolveResult))
    .handle('issueExternalGatewayContext', () => Effect.succeed(gatewayResult)),
);

const makeFixture = () =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(ExternalIdentityApi).pipe(
      Layer.provide(fixtureHandlers),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

const makeFetch =
  (server: ReturnType<typeof makeFixture>, requests: Request[]): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const forwardedUrl = new URL(request.url);
    if (forwardedUrl.pathname === shellApiPrefix || forwardedUrl.pathname.startsWith(`${shellApiPrefix}/`)) {
      forwardedUrl.pathname = forwardedUrl.pathname.slice(shellApiPrefix.length) || '/';
    }
    return server.handler(new Request(forwardedUrl, request), Context.empty());
  };

it.live('uses the real neutral HTTP fixture for all six typed operations', () =>
  Effect.gen(function* typedExternalIdentityHttpScenario() {
    const requests: Request[] = [];
    const server = yield* Effect.acquireRelease(Effect.sync(makeFixture), (runtimeServer) =>
      Effect.promise(() => runtimeServer.dispose()),
    );
    const fetch = makeFetch(server, requests);
    const mutationOptions = {
      apiKey,
      baseUrl,
      idempotencyKey,
      requestCorrelation,
    };
    const readOptions = { apiKey, baseUrl, requestCorrelation };

    expect(
      yield* reservePrincipalBinding(reserveRequest, mutationOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ).toEqual(reserveResult);
    expect(
      yield* activatePrincipalBinding(activateRequest, mutationOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(mutationOptions)),
      ),
    ).toEqual(activateResult);
    expect(
      yield* changePrincipalBindingStatus(statusRequest, mutationOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(mutationOptions)),
      ),
    ).toEqual(statusResult);
    expect(
      yield* readPrincipalBinding(readRequest, readOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(readOptions)),
      ),
    ).toEqual(readResult);
    expect(
      yield* resolveExternalSubject(resolveRequest, readOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(readOptions)),
      ),
    ).toEqual(resolveResult);
    expect(
      yield* issueExternalGatewayContext(gatewayRequest, readOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(readOptions)),
      ),
    ).toEqual(gatewayResult);

    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/auth/identity/external/bindings/reserve`,
      `${baseUrl}/auth/identity/external/bindings/activate`,
      `${baseUrl}/auth/identity/external/binding/status`,
      `${baseUrl}/auth/identity/external/bindings/read`,
      `${baseUrl}/auth/identity/external/resolve`,
      `${baseUrl}/auth/identity/external/gateway-context`,
    ]);
    for (const request of requests) {
      expect(request.headers.get('x-api-key')).toBe('dedicated-external-identity-key');
      expect(request.headers.get('x-correlation-id')).toBe(requestCorrelation);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
    }
    expect(requests.slice(0, 3).map((request) => request.headers.get('idempotency-key'))).toEqual([
      idempotencyKey,
      idempotencyKey,
      idempotencyKey,
    ]);
    expect(requests.slice(3).every((request) => request.headers.get('idempotency-key') === null)).toBe(true);

    const reserveRequestSent = requests.at(0);
    expect(reserveRequestSent).toBeDefined();
    if (reserveRequestSent === undefined) {
      return;
    }
    const reserveWire = yield* Effect.promise(() => reserveRequestSent.clone().json());
    expect(reserveWire).toEqual({
      authenticationRef: reserveRequest.authenticationRef,
      reservation: {
        authenticationNamespaceId: reserveRequest.reservation.authenticationNamespaceId,
        displayName: reserveRequest.reservation.displayName,
        providerSubjectId: reserveRequest.reservation.providerSubjectId,
        subjectType: reserveRequest.reservation.subjectType,
      },
    });
  }),
);

it.live('isolates explicit per-call transport options from missing or conflicting ambient context', () =>
  Effect.gen(function* perCallTransportOptionsScenario() {
    const requests: Request[] = [];
    const server = yield* Effect.acquireRelease(Effect.sync(makeFixture), (runtimeServer) =>
      Effect.promise(() => runtimeServer.dispose()),
    );
    const fetch = makeFetch(server, requests);
    const explicitOptions = { apiKey, baseUrl, requestCorrelation };
    const conflictingAmbientOptions = {
      apiKey: Redacted.make('ambient-conflicting-key'),
      baseUrl: 'https://ambient.ontos.test/ambient-super-app-api',
      requestCorrelation: 'ambient-conflicting-correlation',
    };

    expect(
      yield* readPrincipalBinding(readRequest, explicitOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ).toEqual(readResult);
    expect(
      yield* resolveExternalSubject(resolveRequest, explicitOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(externalIdentityTransportLayer(conflictingAmbientOptions)),
      ),
    ).toEqual(resolveResult);

    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/auth/identity/external/bindings/read`,
      `${baseUrl}/auth/identity/external/resolve`,
    ]);
    for (const request of requests) {
      expect(request.headers.get('x-api-key')).toBe('dedicated-external-identity-key');
      expect(request.headers.get('x-correlation-id')).toBe(requestCorrelation);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
    }
  }),
);

it.live('re-runs the service-authenticated operation for a bounded retry and keeps the typed failure', () =>
  Effect.gen(function* retryExternalIdentityHttpScenario() {
    let attempt = 0;
    const requests: Request[] = [];
    const unavailable = ExternalIdentityUnavailableProblemSchema.make({
      detail: 'The neutral identity service is temporarily unavailable.',
      retryable: true,
      status: 503,
      title: 'External identity unavailable',
      type: 'https://ontos.dev/problems/external-identity-unavailable',
    });
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(ExternalIdentityApi).pipe(
            Layer.provide(
              HttpApiBuilder.group(ExternalIdentityApi, 'externalIdentity', (handlers) =>
                handlers
                  .handle('reservePrincipalBinding', () => {
                    attempt += 1;
                    return attempt === 1 ? Effect.fail(unavailable) : Effect.succeed(reserveResult);
                  })
                  .handle('activatePrincipalBinding', () => Effect.succeed(activateResult))
                  .handle('changePrincipalBindingStatus', () => Effect.succeed(statusResult))
                  .handle('readPrincipalBinding', () => Effect.succeed(readResult))
                  .handle('resolveExternalSubject', () => Effect.succeed(resolveResult))
                  .handle('issueExternalGatewayContext', () => Effect.succeed(gatewayResult)),
              ),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const fetch = makeFetch(server, requests);

    const result = yield* reservePrincipalBinding(reserveRequest, {
      apiKey,
      baseUrl,
      idempotencyKey,
      requestCorrelation,
    }).pipe(
      Effect.catchTag('ExternalIdentityUnavailableProblem', () =>
        reservePrincipalBinding(reserveRequest, {
          apiKey,
          baseUrl,
          idempotencyKey,
          requestCorrelation,
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(
        externalIdentityTransportLayer({
          apiKey,
          baseUrl,
          requestCorrelation,
        }),
      ),
    );

    expect(result).toEqual(reserveResult);
    expect(attempt).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get('x-api-key'))).toEqual([
      'dedicated-external-identity-key',
      'dedicated-external-identity-key',
    ]);
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([null, null]);
    expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([idempotencyKey, idempotencyKey]);
  }),
);

it.live('decodes a declared typed failure and sends only the trusted service credential', () =>
  Effect.gen(function* typedFailureScenario() {
    const forbidden = ExternalIdentityForbiddenProblemSchema.make({
      detail: 'The workload is not granted for this external identity operation.',
      status: 403,
      title: 'External identity forbidden',
      type: 'https://ontos.dev/problems/external-identity-forbidden',
    });
    const requests: Request[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(ExternalIdentityApi).pipe(
            Layer.provide(
              HttpApiBuilder.group(ExternalIdentityApi, 'externalIdentity', (handlers) =>
                handlers
                  .handle('reservePrincipalBinding', () => Effect.succeed(reserveResult))
                  .handle('activatePrincipalBinding', () => Effect.succeed(activateResult))
                  .handle('changePrincipalBindingStatus', () => Effect.succeed(statusResult))
                  .handle('readPrincipalBinding', () => Effect.succeed(readResult))
                  .handle('resolveExternalSubject', () => Effect.fail(forbidden))
                  .handle('issueExternalGatewayContext', () => Effect.succeed(gatewayResult)),
              ),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const fetch = makeFetch(server, requests);
    const failure = yield* Effect.flip(
      resolveExternalSubject(resolveRequest, {
        apiKey,
        baseUrl,
        requestCorrelation,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).pipe(
      Effect.provide(
        externalIdentityTransportLayer({
          apiKey,
          baseUrl,
          requestCorrelation,
        }),
      ),
    );

    expect(Schema.is(ExternalIdentityForbiddenProblemSchema)(failure)).toBe(true);
    expect(failure).toEqual(forbidden);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('x-api-key')).toBe('dedicated-external-identity-key');
    expect(requests[0]?.headers.get('x-correlation-id')).toBe(requestCorrelation);
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  }),
);

it('keeps the six route inputs schema-backed and rejects a raw subject without authenticationRef', () => {
  expect(() =>
    Schema.decodeUnknownSync(ReservePrincipalBindingRequestSchema)({
      reservation: reserveRequest.reservation,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResolveExternalSubjectRequestSchema)({
      authenticationNamespaceId: resolveRequest.authenticationNamespaceId,
      providerSubjectId: resolveRequest.providerSubjectId,
      subjectType: resolveRequest.subjectType,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ExternalGatewayContextRequestSchema)({
      audience: gatewayRequest.audience,
      authenticationNamespaceId: gatewayRequest.authenticationNamespaceId,
      providerSubjectId: gatewayRequest.providerSubjectId,
      subjectType: gatewayRequest.subjectType,
    }),
  ).toThrow();
});
