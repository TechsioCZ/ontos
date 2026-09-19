import { ActionCommitIndeterminate, ActionRuntime, PrincipalResolver, ReadRuntime } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import {
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceRegistrationSchema,
  ChangePrincipalBindingStatusResultSchema,
  ExternalAuthenticationSubjectSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
  ResolveExternalSubjectResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
  makeAuthenticationNamespaceRegistry,
  makeTrustedAuthenticationAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import type {
  TrustedAdmissionObservationService,
  TrustedAuthenticationAdmissionServiceContract,
} from '@app/core-runtime/auth/external-identity-admission';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Clock, Context, Crypto, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import { ApiKeyService } from '../../api/auth/api-key-service.ts';
import { ExternalIdentityApi } from '@app/shared-contracts';
import { ExternalIdentityUnavailableProblemSchema } from '@app/shared-contracts/external-identity';
import {
  ExternalIdentityHttpConfigurationSchema,
  ExternalIdentityHttpConfigurationService,
  externalIdentityWorkloadAuthorizationLive,
  externalIdentityStandaloneGroupLive,
} from '../../api/auth/external-identity/index.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import { actionCoreFailure, actionSuccess, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const workloadPrincipalId = '40000000-0000-4000-8000-000000000001';
const workloadBindingId = '45000000-0000-4000-8000-000000000001';
const customerBindingId = '70000000-0000-4000-8000-000000000001';
const customerPrincipalId = '70000000-0000-4000-8000-000000000002';
const customerProviderSubjectId = 'fixture-customer-subject';
const customerBindingRevision = 4;
const staffNamespace = 'test.staff.better-auth.v1';
const customerNamespace = 'test.customer.external.v1';
const audience = 'shell-super-app';
const gatewayAudience = 'commerce-customer-context';
const attesterPrincipalId = '50000000-0000-4000-8000-000000000001';
const admissionNow = DateTime.makeUnsafe('2026-09-17T00:00:00.000Z');
const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());

const decode = <S extends Schema.ConstraintDecoder<unknown>, Value>(schema: S, input: Value): S['Type'] =>
  Schema.decodeUnknownSync(schema)(input);

const bindingReadResult = decode(ReadPrincipalBindingResultSchema, {
  authBindingId: customerBindingId,
  authenticationNamespaceId: customerNamespace,
  bindingRevision: customerBindingRevision,
  bindingStatus: 'active',
  originalInvocationId: null,
  outcome: 'FOUND',
  principalId: customerPrincipalId,
  principalStatus: 'active',
  tenantStatus: 'active',
});
const bindingReadWireResult = {
  ...bindingReadResult,
  originalInvocationId: null,
};

const resolveResult = decode(ResolveExternalSubjectResultSchema, {
  authBindingId: customerBindingId,
  authenticationNamespaceId: customerNamespace,
  bindingRevision: customerBindingRevision,
  bindingStatus: 'active',
  outcome: 'RESOLVED',
  principalId: customerPrincipalId,
  tenantId,
});

const revokedResult = decode(ChangePrincipalBindingStatusResultSchema, {
  authBindingId: customerBindingId,
  bindingRevision: 5,
  bindingStatus: 'revoked',
  previousStatus: 'active',
  principalId: customerPrincipalId,
  transitionRef: '80000000-0000-4000-8000-000000000001',
});

const configuration = decode(ExternalIdentityHttpConfigurationSchema, {
  grants: [
    {
      operation: 'read',
      receivingAudience: audience,
      targetAuthenticationNamespaceId: customerNamespace,
      tenantId,
      workloadAuthenticationNamespaceId: staffNamespace,
      workloadPrincipalId,
    },
    {
      operation: 'status',
      receivingAudience: audience,
      targetAuthenticationNamespaceId: customerNamespace,
      tenantId,
      workloadAuthenticationNamespaceId: staffNamespace,
      workloadPrincipalId,
    },
    {
      operation: 'resolve',
      receivingAudience: audience,
      targetAuthenticationNamespaceId: customerNamespace,
      tenantId,
      workloadAuthenticationNamespaceId: staffNamespace,
      workloadPrincipalId,
    },
    {
      operation: 'gateway-context',
      receivingAudience: audience,
      targetAudience: gatewayAudience,
      targetAuthenticationNamespaceId: customerNamespace,
      tenantId,
      workloadAuthenticationNamespaceId: staffNamespace,
      workloadPrincipalId,
    },
  ],
  providerEndpointAudience: audience,
});

const testCrypto = Crypto.make({
  digest: (_algorithm, data) => Effect.succeed(data),
  randomBytes: (size) => new Uint8Array(size),
});

const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
  decode(AuthenticationNamespaceRegistrationSchema, {
    allowedAudiences: [audience, gatewayAudience],
    authenticationNamespaceId: customerNamespace,
    provider: 'fixture-provider',
    requiresOperationAdmission: true,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [attesterPrincipalId],
  }),
]);

const makeAdmissionClock = (initial: DateTime.Utc): Clock.Clock => {
  const currentMillis = DateTime.toEpochMillis(initial);
  return {
    currentTimeMillis: Effect.succeed(currentMillis),
    currentTimeMillisUnsafe: () => currentMillis,
    currentTimeNanos: Effect.succeed(BigInt(currentMillis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    monotonicTimeNanos: Effect.succeed(BigInt(currentMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    sleep: () => Effect.void,
  };
};

const makeAuthenticationAdmissionService = (): TrustedAuthenticationAdmissionServiceContract => {
  const timeline = makeAdmissionClock(admissionNow);
  const observer: TrustedAdmissionObservationService = {
    observeAuthentication: (input) =>
      Effect.succeed(
        decode(AuthenticationAdmissionObservationSchema, {
          audience: input.audience,
          authBindingId: input.authBindingId,
          authContextRef: input.authContextRef,
          authenticationNamespaceId: input.authenticationNamespaceId,
          bindingRevision: customerBindingRevision,
          expiresAt: DateTime.add(admissionNow, { milliseconds: 4000 }),
          nonce: input.nonce,
          observedAt: admissionNow,
          operationRef: input.operationRef,
          principalId: input.principalId,
          tenantId: input.tenantId,
        }),
      ),
    observeExternalSubject: () => Effect.die('The HTTP fixture must not call external subject admission'),
  };
  const service = makeTrustedAuthenticationAdmissionService({
    attesterPrincipalId,
    maxAdmissionWindowMillis: 5000,
  });
  return {
    verify: (input) =>
      service
        .verify(input)
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
          Effect.provideService(TrustedAdmissionObservation, observer),
          Effect.provideService(Clock.Clock, timeline),
        ),
  };
};

const makeReadRuntime = (
  readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[],
  resolvedSubjects: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>[],
): ReadRuntimeService => ({
  runRead: (input) => {
    if (input.registration.descriptor.readKey === 'core.identity.read-principal-binding') {
      const decodedInput = Schema.decodeUnknownSync(ReadPrincipalBindingPayloadSchema)(input.input);
      readPayloads.push(decodedInput);
      return Effect.succeed(bindingReadResult);
    }
    if (input.registration.descriptor.readKey === 'core.identity.resolve-external-subject') {
      const decodedSubject = Schema.decodeUnknownSync(ExternalAuthenticationSubjectSchema)(input.input);
      resolvedSubjects.push(decodedSubject);
      return Effect.succeed(resolveResult);
    }
    return Effect.die('The HTTP fixture received an unexpected read registration');
  },
});

const makeServer = (
  outcomes: Parameters<typeof makeActionRuntimeDouble>[0],
  readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[],
  resolvedSubjects: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>[] = [],
) => {
  const actionRuntime = makeActionRuntimeDouble(outcomes);
  const apiKeyService = makeApiKeyServiceDouble({
    verify: (rawKey) =>
      rawKey === 'workload-api-key'
        ? Effect.succeed({ providerKeyId: 'better-auth-workload-key' })
        : Effect.die('Unexpected API key in the HTTP fixture'),
  });
  const principalResolver = makePrincipalResolverDouble({
    authenticationNamespaceId: staffNamespace,
    resolveBetterAuthApiKey: (providerKeyId) =>
      providerKeyId === 'better-auth-workload-key'
        ? Effect.succeed({
            authBindingId: workloadBindingId,
            displayName: 'Fixture workload',
            principalId: workloadPrincipalId,
            principalKind: 'service',
            tenantId,
          })
        : Effect.die('Unexpected provider key in the HTTP fixture'),
  });
  const readRuntime = makeReadRuntime(readPayloads, resolvedSubjects);
  const admissionService = {
    admit: () => Effect.die('The revoke/read fixture must not call external subject admission'),
  };
  const authenticationAdmissionService = makeAuthenticationAdmissionService();
  const gatewayIssuer = {
    issue: () => Effect.succeed({ expiresAt: 1_700_000_300, token: 'fixture-gateway-token' }),
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(ActionRuntime, actionRuntime.runtime),
    Layer.succeed(ApiKeyService, apiKeyService),
    Layer.succeed(ExternalIdentityHttpConfigurationService, configuration),
    Layer.succeed(GatewayIssuer, gatewayIssuer),
    Layer.succeed(PrincipalResolver, principalResolver),
    Layer.succeed(ReadRuntime, readRuntime),
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.succeed(TrustedAuthenticationAdmissionService, authenticationAdmissionService),
    Layer.succeed(TrustedExternalSubjectAdmissionService, admissionService),
  );
  return {
    actionRuntime,
    server: HttpRouter.toWebHandler(
      HttpApiBuilder.layer(ExternalIdentityApi).pipe(
        Layer.provide(externalIdentityStandaloneGroupLive),
        Layer.provide(externalIdentityWorkloadAuthorizationLive),
        Layer.provide(dependencies),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    ),
  };
};

const statusRequest = () =>
  new Request('https://fixture.ontos.test/auth/identity/external/binding/status', {
    body: JSON.stringify({
      change: {
        authBindingId: customerBindingId,
        expectedRevision: 4,
        reason: 'Remove fixture binding',
        requestedStatus: 'revoked',
      },
    }),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'fixture-status-idempotency',
      'x-api-key': 'workload-api-key',
      'x-correlation-id': 'fixture-status-correlation',
    },
    method: 'POST',
  });

const readRequest = () =>
  new Request('https://fixture.ontos.test/auth/identity/external/bindings/read', {
    body: JSON.stringify({ authBindingId: customerBindingId, lookup: 'binding' }),
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'workload-api-key',
      'x-correlation-id': 'fixture-read-correlation',
    },
    method: 'POST',
  });

const resolveRequest = () =>
  new Request('https://fixture.ontos.test/auth/identity/external/resolve', {
    body: JSON.stringify({
      authenticationNamespaceId: customerNamespace,
      authenticationRef: 'fixture-customer-authentication',
      providerSubjectId: customerProviderSubjectId,
      subjectType: 'user',
    }),
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'workload-api-key',
      'x-correlation-id': 'fixture-resolve-correlation',
    },
    method: 'POST',
  });

const acquireServer = (fixture: ReturnType<typeof makeServer>) =>
  Effect.acquireRelease(Effect.succeed(fixture.server), (runtimeServer) =>
    Effect.promise(() => runtimeServer.dispose()),
  );

const gatewayRequest = () =>
  new Request('https://fixture.ontos.test/auth/identity/external/gateway-context', {
    body: JSON.stringify({
      audience: gatewayAudience,
      authenticationNamespaceId: customerNamespace,
      authenticationRef: 'fixture-customer-authentication',
      providerSubjectId: customerProviderSubjectId,
      subjectType: 'user',
    }),
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'workload-api-key',
      'x-correlation-id': 'fixture-gateway-correlation',
    },
    method: 'POST',
  });

it.live('runs binding-id HTTP reads and provider-independent revoke through the governed seams', () =>
  Effect.gen(function* externalIdentityHttpScenario() {
    const readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[] = [];
    const fixture = makeServer([actionSuccess(revokedResult)], readPayloads);
    const server = yield* acquireServer(fixture);

    const readResponse = yield* Effect.promise(() => server.handler(readRequest(), emptyRequestContext));
    const readBody = yield* Effect.promise(() => readResponse.json());
    expect({ body: readBody, payloads: readPayloads, status: readResponse.status }).toEqual({
      body: bindingReadWireResult,
      payloads: [{ authBindingId: customerBindingId, lookup: 'binding' }],
      status: 200,
    });
    expect(readPayloads[0]).toEqual({ authBindingId: customerBindingId, lookup: 'binding' });

    const statusResponse = yield* Effect.promise(() => server.handler(statusRequest(), emptyRequestContext));
    const statusBody = yield* Effect.promise(() => statusResponse.json());
    expect({
      body: statusBody,
      invocations: fixture.actionRuntime.invocationCount(),
      status: statusResponse.status,
    }).toEqual({
      body: revokedResult,
      invocations: 1,
      status: 200,
    });
    expect(fixture.actionRuntime.invocationCount()).toBe(1);
  }),
);

it.live('projects resolve and gateway subjects before the Core read decoder', () =>
  Effect.gen(function* externalIdentitySubjectProjectionScenario() {
    const readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[] = [];
    const resolvedSubjects: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>[] = [];
    const fixture = makeServer([], readPayloads, resolvedSubjects);
    const server = yield* acquireServer(fixture);

    const resolveResponse = yield* Effect.promise(() => server.handler(resolveRequest(), emptyRequestContext));
    const resolveBody = yield* Effect.promise(() => resolveResponse.json());
    expect({ body: resolveBody, status: resolveResponse.status }).toEqual({
      body: resolveResult,
      status: 200,
    });

    const gatewayResponse = yield* Effect.promise(() => server.handler(gatewayRequest(), emptyRequestContext));
    const gatewayBody = yield* Effect.promise(() => gatewayResponse.json());
    expect({ body: gatewayBody, status: gatewayResponse.status }).toEqual({
      body: { expiresAt: 1_700_000_300, token: 'fixture-gateway-token' },
      status: 200,
    });
    expect(resolvedSubjects).toEqual([
      {
        authenticationNamespaceId: customerNamespace,
        providerSubjectId: customerProviderSubjectId,
        subjectType: 'user',
      },
      {
        authenticationNamespaceId: customerNamespace,
        providerSubjectId: customerProviderSubjectId,
        subjectType: 'user',
      },
    ]);
    expect(readPayloads).toEqual([
      {
        authenticationNamespaceId: customerNamespace,
        lookup: 'subject',
        providerSubjectId: customerProviderSubjectId,
        subjectType: 'user',
      },
      {
        authenticationNamespaceId: customerNamespace,
        lookup: 'subject',
        providerSubjectId: customerProviderSubjectId,
        subjectType: 'user',
      },
    ]);
  }),
);

it.live('rejects browser/session credentials and malformed input before a Core action', () =>
  Effect.gen(function* externalIdentityBoundaryScenario() {
    const readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[] = [];
    const fixture = makeServer([actionSuccess(revokedResult)], readPayloads);
    const server = yield* acquireServer(fixture);

    const browserResponse = yield* Effect.promise(() =>
      server.handler(
        new Request('https://fixture.ontos.test/auth/identity/external/bindings/read', {
          body: JSON.stringify({ authBindingId: customerBindingId, lookup: 'binding' }),
          headers: {
            authorization: 'Bearer browser-session-token',
            'content-type': 'application/json',
            cookie: 'session=browser-session',
            'x-correlation-id': 'fixture-browser-correlation',
          },
          method: 'POST',
        }),
        emptyRequestContext,
      ),
    );
    expect(browserResponse.status).toBe(401);

    const malformedResponse = yield* Effect.promise(() =>
      server.handler(
        new Request('https://fixture.ontos.test/auth/identity/external/bindings/read', {
          body: JSON.stringify({ authBindingId: 'malformed', lookup: 'binding' }),
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'workload-api-key',
            'x-correlation-id': 'fixture-malformed-correlation',
          },
          method: 'POST',
        }),
        emptyRequestContext,
      ),
    );
    expect(malformedResponse.status).toBe(400);
    expect(fixture.actionRuntime.invocationCount()).toBe(0);
    expect(readPayloads).toHaveLength(0);
  }),
);

it.live('returns a typed unavailable result and permits retry after an indeterminate action commit', () =>
  Effect.gen(function* externalIdentityRecoveryScenario() {
    const readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[] = [];
    const fixture = makeServer(
      [
        actionCoreFailure(
          new ActionCommitIndeterminate({
            code: 'action_commit_indeterminate',
            invocationId: '90000000-0000-4000-8000-000000000001',
            reason: 'The fixture commit outcome is unknown',
          }),
        ),
        actionSuccess(revokedResult),
      ],
      readPayloads,
    );
    const server = yield* acquireServer(fixture);

    const first = yield* Effect.promise(() => server.handler(statusRequest(), emptyRequestContext));
    const firstBody = yield* Effect.promise(() => first.json());
    expect({ body: firstBody, invocations: fixture.actionRuntime.invocationCount(), status: first.status }).toEqual({
      body: expect.toSatisfy((value) => Schema.is(ExternalIdentityUnavailableProblemSchema)(value)),
      invocations: 1,
      status: 503,
    });

    const second = yield* Effect.promise(() => server.handler(statusRequest(), emptyRequestContext));
    const secondBody = yield* Effect.promise(() => second.json());
    expect({ body: secondBody, status: second.status }).toEqual({ body: revokedResult, status: 200 });
    expect(fixture.actionRuntime.invocationCount()).toBe(2);
  }),
);

it.live('attributes the governed action invocation to the api_key workload Principal, never the customer subject', () =>
  Effect.gen(function* externalIdentityWorkloadAttributionScenario() {
    const readPayloads: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>[] = [];
    const fixture = makeServer([actionSuccess(revokedResult)], readPayloads);
    const server = yield* acquireServer(fixture);

    const statusResponse = yield* Effect.promise(() => server.handler(statusRequest(), emptyRequestContext));
    expect(statusResponse.status).toBe(200);
    expect(fixture.actionRuntime.principals).toHaveLength(1);
    const [recordedPrincipal] = fixture.actionRuntime.principals;
    expect(recordedPrincipal).toEqual({
      authBindingId: workloadBindingId,
      authContextRef: 'better-auth-api-key:better-auth-workload-key',
      authenticationNamespaceId: staffNamespace,
      authMethod: 'api_key',
      principalId: workloadPrincipalId,
      tenantId,
    });
    // Never the customer subject the statusRequest binding targets.
    expect(recordedPrincipal).not.toMatchObject({ principalId: customerPrincipalId });
    expect(recordedPrincipal).not.toMatchObject({ authenticationNamespaceId: customerNamespace });
    // No impersonation key present: this is the workload's own identity, not a delegated/impersonated one.
    expect(
      Predicate.hasProperty(recordedPrincipal, 'impersonatedByPrincipalId') &&
        recordedPrincipal['impersonatedByPrincipalId'] !== undefined,
    ).toBe(false);
  }),
);
