import { Clock, DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  AuthBindingIdSchema,
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
  ExternalAuthenticationSubjectSchema,
  ExternalSubjectAdmissionObservationSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/auth/external-identity-contracts.ts';
import {
  assertAuthenticationAdmission,
  assertExternalSubjectAdmission,
  externalSubjectFromAdmission,
  makeAuthenticationNamespaceRegistry,
  makeTrustedAuthenticationAdmissionService,
  makeTrustedExternalSubjectAdmissionService,
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
} from '../../src/auth/external-identity/verifier.ts';
import type { TrustedAdmissionObservationService } from '../../src/auth/external-identity/verifier.ts';
import { makeOperationalScopeResolver } from '../../src/operations/context.ts';
import type { PersistedScopeRecord } from '../../src/operations/repository-context.ts';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '../../src/operations/errors.ts';
import { externalIdentityFailure } from '../../src/auth/external-identity/errors.ts';
import { ExternalOperationAuthentication } from '../../src/operations/external-authentication.ts';
import type { ExternalOperationAuthenticationRequest } from '../../src/operations/external-authentication.ts';

const namespaceId = Schema.decodeSync(AuthenticationNamespaceIdSchema)('test.third-provider.realm');
const audience = 'external-operation';
const attesterPrincipalId = '60000000-0000-4000-8000-000000000001';
const authBindingId = Schema.decodeSync(AuthBindingIdSchema)('10000000-0000-4000-8000-000000000003');
const now = DateTime.makeUnsafe('2026-09-16T10:00:00.000Z');

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId,
  authContextRef: 'opaque-provider-context',
  authenticationNamespaceId: namespaceId,
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const legacyPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId,
  authContextRef: 'opaque-provider-context',
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
});

const registration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: [audience, 'reserve-binding'],
  authenticationNamespaceId: namespaceId,
  provider: 'test-provider',
  requiresOperationAdmission: true,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [attesterPrincipalId],
});
const optionalNamespaceId = Schema.decodeSync(AuthenticationNamespaceIdSchema)('test.optional.realm');
const optionalRegistration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: [audience],
  authenticationNamespaceId: optionalNamespaceId,
  provider: 'test-provider',
  requiresOperationAdmission: false,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [],
});
const wideNamespaceId = Schema.decodeSync(AuthenticationNamespaceIdSchema)('test.other-provider.realm');
const wideRegistration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: [audience],
  authenticationNamespaceId: wideNamespaceId,
  provider: 'other-test-provider',
  requiresOperationAdmission: true,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [attesterPrincipalId],
});
const registry = makeAuthenticationNamespaceRegistry([registration, optionalRegistration, wideRegistration]);

const activeRecord = {
  bindingAuthenticationNamespaceId: namespaceId,
  bindingPrincipalId: principal.principalId,
  bindingRevision: 1,
  bindingRevokedAt: null,
  bindingStatus: 'active',
  bindingSubjectType: 'user',
  bindingTenantId: principal.tenantId,
  impersonatorStatus: null,
  impersonatorTenantId: null,
  legalEntityStatus: null,
  legalEntityTenantId: null,
  principalStatus: 'active',
  principalTenantId: principal.tenantId,
  tenantStatus: 'active',
};
const input = {
  audience,
  correlationId: 'admission-test',
  legalEntityScope: 'forbidden' as const,
  principal,
};
const access = { legalEntities: () => Effect.succeed([]) };

const preBindingRequest = {
  ...Schema.decodeSync(ExternalAuthenticationSubjectSchema)({
    authenticationNamespaceId: namespaceId,
    providerSubjectId: 'provider-subject-01',
    subjectType: 'user',
  }),
  audience: 'reserve-binding',
  authContextRef: 'opaque-provider-context',
  nonce: '50000000-0000-4000-8000-000000000001',
  operationRef: 'reserve-operation',
  tenantId: TenantIdSchema.make(principal.tenantId),
};
const preBindingObservation = Schema.decodeSync(ExternalSubjectAdmissionObservationSchema)({
  ...preBindingRequest,
  expiresAt: DateTime.add(now, { milliseconds: 1000 }),
  observedAt: now,
});
const preBindingObserver: TrustedAdmissionObservationService = {
  observeAuthentication: () => Effect.fail(externalIdentityFailure('identity_unavailable', 'unused in subject test')),
  observeExternalSubject: () => Effect.succeed(preBindingObservation),
};
const optionalPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  ...principal,
  authenticationNamespaceId: optionalNamespaceId,
});
const unknownPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  ...principal,
  authenticationNamespaceId: 'test.unknown.realm',
});

const operationError = () =>
  new OperationAuthenticationRequired({
    code: 'operation_authentication_required',
    reason: 'Provider admission failed',
  });

const makeAdmissionClock = (initial: DateTime.Utc) => {
  let currentMillis = DateTime.toEpochMillis(initial);
  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => currentMillis),
    currentTimeMillisUnsafe: () => currentMillis,
    currentTimeNanos: Effect.sync(() => BigInt(currentMillis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(currentMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    sleep: () => Effect.void,
  };
  return {
    clock,
    set: (time: DateTime.Utc) => {
      currentMillis = DateTime.toEpochMillis(time);
    },
  };
};

const makeBoundAdapter = (
  revisions: () => number,
  observations: { readonly nonce: string; readonly operationRef: string }[],
  stages?: string[],
  timeline = makeAdmissionClock(now),
  expiresInMillis = 1000,
) => {
  const observer: TrustedAdmissionObservationService = {
    observeAuthentication: (request) => {
      const observation = Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
        audience: request.audience,
        authBindingId: request.authBindingId,
        authContextRef: request.authContextRef,
        authenticationNamespaceId: request.authenticationNamespaceId,
        bindingRevision: revisions(),
        expiresAt: DateTime.add(now, { milliseconds: expiresInMillis }),
        nonce: request.nonce,
        observedAt: now,
        operationRef: request.operationRef,
        principalId: request.principalId,
        tenantId: request.tenantId,
      });
      return Effect.succeed(observation);
    },
    observeExternalSubject: () => Effect.succeed(preBindingObservation),
  };
  const trusted = makeTrustedAuthenticationAdmissionService({
    attesterPrincipalId,
    maxAdmissionWindowMillis: 5000,
  });
  return {
    timeline,
    verify: (request: ExternalOperationAuthenticationRequest) => {
      stages?.push('P');
      observations.push({ nonce: request.nonce, operationRef: request.operationRef });
      return trusted
        .verify({
          audience: request.audience,
          authBindingId: request.authBindingId,
          authContextRef: request.authContextRef,
          authenticationNamespaceId: request.authenticationNamespaceId,
          nonce: request.nonce,
          operationRef: request.operationRef,
          principalId: request.principalId,
          subjectType: request.subjectType,
          tenantId: request.tenantId,
        })
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(TrustedAdmissionObservation, observer),
          Effect.provideService(Clock.Clock, timeline.clock),
          Effect.mapError(operationError),
        );
    },
  };
};

it.effect('fails closed before Core observation when the registry or required adapter is missing', () =>
  Effect.gen(function* providerFailClosed() {
    let reads = 0;
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.sync(() => {
            reads += 1;
            return activeRecord;
          }),
      },
      access,
    );

    const missingRegistry = yield* resolver.resolve(input).pipe(Effect.flip);
    expect(missingRegistry).toBeInstanceOf(OperationContextUnavailable);

    const missingAdapter = yield* resolver
      .resolve(input)
      .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry), Effect.flip);
    expect(missingAdapter).toBeInstanceOf(OperationContextUnavailable);
    expect(reads).toBe(0);

    const rejected = yield* resolver.resolve(input).pipe(
      Effect.provideService(AuthenticationNamespaceRegistry, registry),
      Effect.provideService(ExternalOperationAuthentication, {
        verify: () => Effect.fail(operationError()),
      }),
      Effect.flip,
    );
    expect(rejected).toBeInstanceOf(OperationAuthenticationRequired);
    expect(reads).toBe(0);
  }),
);

it.effect('performs fresh P then fresh C on each retry and binds each admission to the C revision', () =>
  Effect.gen(function* freshObservationOrder() {
    const observations: { readonly nonce: string; readonly operationRef: string }[] = [];
    const stages: string[] = [];
    let revision = 1;
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.sync(() => {
            stages.push('C');
            return { ...activeRecord, bindingRevision: revision };
          }),
      },
      access,
    );
    const adapter = makeBoundAdapter(() => 1, observations, stages);
    const resolve = resolver
      .resolve(input)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(ExternalOperationAuthentication, adapter),
      );

    yield* resolve;
    revision = 2;
    const denial = yield* resolve.pipe(Effect.flip);
    expect(denial).toBeInstanceOf(OperationAuthenticationRequired);
    expect(stages).toEqual(['P', 'C', 'P', 'C']);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.operationRef).not.toBe(observations[1]?.operationRef);
    expect(observations[0]?.nonce).not.toBe(observations[1]?.nonce);
  }),
);

it.effect('rejects admission when the Core load is delayed past the proof deadline', () =>
  Effect.gen(function* delayedCoreLoad() {
    const observations: { readonly nonce: string; readonly operationRef: string }[] = [];
    const stages: string[] = [];
    const timeline = makeAdmissionClock(now);
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.sync(() => {
            stages.push('C');
            timeline.set(DateTime.add(now, { milliseconds: 2000 }));
            return activeRecord;
          }),
      },
      access,
    );
    const adapter = makeBoundAdapter(() => 1, observations, stages, timeline, 1000);
    const denied = yield* resolver
      .resolve(input)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(ExternalOperationAuthentication, adapter),
        Effect.flip,
      );
    expect(denied).toBeInstanceOf(OperationAuthenticationRequired);
    expect(stages).toEqual(['P', 'C']);
    expect(observations).toHaveLength(1);
  }),
);

it.effect('accepts a generic namespace without owner policy or application identity fields', () =>
  Effect.gen(function* genericNamespace() {
    const observations: { readonly nonce: string; readonly operationRef: string }[] = [];
    const resolver = makeOperationalScopeResolver({ load: () => Effect.succeed(activeRecord) }, access);
    const scope = yield* resolver.resolve(input).pipe(
      Effect.provideService(AuthenticationNamespaceRegistry, registry),
      Effect.provideService(
        ExternalOperationAuthentication,
        makeBoundAdapter(() => 1, observations),
      ),
    );
    expect(scope.authenticationNamespaceId).toBe(namespaceId);
    expect(scope.authBindingId).toBe(principal.authBindingId);
    expect(observations).toHaveLength(1);
  }),
);

it.effect('denies a namespace-less legacy context when its persisted binding is external', () =>
  Effect.gen(function* namespaceLessExternalBinding() {
    let reads = 0;
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.sync(() => {
            reads += 1;
            return activeRecord;
          }),
      },
      access,
    );
    const denied = yield* resolver.resolve({ ...input, principal: legacyPrincipal }).pipe(Effect.flip);
    expect(denied).toBeInstanceOf(OperationAuthenticationRequired);
    expect(reads).toBe(1);
  }),
);

it.effect('scopes missing admission to the affected namespace and keeps optional registrations adapter-free', () =>
  Effect.gen(function* namespaceConfiguration() {
    let reads = 0;
    const resolver = makeOperationalScopeResolver(
      {
        load: (candidate) =>
          Effect.sync(() => {
            reads += 1;
            return candidate.authenticationNamespaceId === optionalNamespaceId
              ? { ...activeRecord, bindingAuthenticationNamespaceId: optionalNamespaceId }
              : activeRecord;
          }),
      },
      access,
    );
    const optionalScope = yield* resolver
      .resolve({ ...input, principal: optionalPrincipal })
      .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
    expect(optionalScope.authenticationNamespaceId).toBe(optionalNamespaceId);
    expect(reads).toBe(1);

    const wrongAudience = yield* resolver
      .resolve({ ...input, audience: 'unregistered-audience' })
      .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry), Effect.flip);
    expect(wrongAudience).toBeInstanceOf(OperationAuthenticationRequired);
    expect(reads).toBe(1);

    const unknown = yield* resolver
      .resolve({ ...input, principal: unknownPrincipal })
      .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry), Effect.flip);
    expect(unknown).toBeInstanceOf(OperationAuthenticationRequired);
    expect(reads).toBe(1);
  }),
);

it.effect('keeps pre-binding subject admission separate from bound authentication admission', () =>
  Effect.gen(function* preBindingProof() {
    const timeline = makeAdmissionClock(now);
    const trusted = makeTrustedExternalSubjectAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 5000,
    });
    const admission = yield* trusted
      .admit({ ...preBindingRequest })
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(TrustedAdmissionObservation, preBindingObserver),
        Effect.provideService(Clock.Clock, timeline.clock),
      );
    expect(yield* externalSubjectFromAdmission(admission)).toEqual({
      authenticationNamespaceId: namespaceId,
      providerSubjectId: 'provider-subject-01',
      subjectType: 'user',
    });
    const wrongContext = yield* Effect.flip(
      assertExternalSubjectAdmission(admission, {
        ...preBindingRequest,
        authContextRef: 'another-provider-context',
      }),
    );
    expect(wrongContext.code).toBe('identity_invalid');
    yield* assertExternalSubjectAdmission(admission, preBindingRequest);
    const replay = yield* Effect.flip(assertExternalSubjectAdmission(admission, preBindingRequest));
    expect(replay.code).toBe('identity_invalid');
    const wrongKind = yield* Effect.flip(
      assertAuthenticationAdmission(admission, {
        audience: preBindingRequest.audience,
        authBindingId,
        authContextRef: 'opaque-provider-context',
        authenticationNamespaceId: preBindingRequest.authenticationNamespaceId,
        bindingRevision: 1,
        nonce: preBindingRequest.nonce,
        operationRef: preBindingRequest.operationRef,
        principalId: PrincipalIdSchema.make(principal.principalId),
        tenantId: TenantIdSchema.make(principal.tenantId),
      }),
    );
    expect(wrongKind.code).toBe('identity_invalid');
  }),
);

it.effect('rechecks admission deadlines at consumption and consumes exactly once', () =>
  Effect.gen(function* admissionConsumption() {
    const timeline = makeAdmissionClock(now);
    const subjectTrusted = makeTrustedExternalSubjectAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 5000,
    });
    const subjectAdmission = yield* subjectTrusted
      .admit(preBindingRequest)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(TrustedAdmissionObservation, preBindingObserver),
        Effect.provideService(Clock.Clock, timeline.clock),
      );

    const boundInput = {
      audience,
      authBindingId,
      authContextRef: 'opaque-provider-context',
      authenticationNamespaceId: namespaceId,
      nonce: '50000000-0000-4000-8000-000000000002',
      operationRef: 'bound-operation',
      principalId: PrincipalIdSchema.make(principal.principalId),
      subjectType: 'user' as const,
      tenantId: TenantIdSchema.make(principal.tenantId),
    };
    const boundTrusted = makeTrustedAuthenticationAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 5000,
    });
    const boundObserver: TrustedAdmissionObservationService = {
      observeAuthentication: (request) =>
        Effect.succeed(
          Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            bindingRevision: 1,
            expiresAt: DateTime.add(now, { milliseconds: 1000 }),
            nonce: request.nonce,
            observedAt: now,
            operationRef: request.operationRef,
            principalId: request.principalId,
            tenantId: request.tenantId,
          }),
        ),
      observeExternalSubject: () => Effect.succeed(preBindingObservation),
    };
    const boundAdmission = yield* boundTrusted
      .verify(boundInput)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(TrustedAdmissionObservation, boundObserver),
        Effect.provideService(Clock.Clock, timeline.clock),
      );

    timeline.set(DateTime.add(now, { milliseconds: 2000 }));
    const subjectExpired = yield* Effect.exit(assertExternalSubjectAdmission(subjectAdmission, preBindingRequest));
    const boundExpired = yield* Effect.exit(
      assertAuthenticationAdmission(boundAdmission, {
        ...boundInput,
        bindingRevision: 1,
      }),
    );
    expect(Exit.isFailure(subjectExpired)).toBe(true);
    expect(Exit.isFailure(boundExpired)).toBe(true);

    timeline.set(now);
    const reusable = yield* boundTrusted
      .verify(boundInput)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(TrustedAdmissionObservation, boundObserver),
        Effect.provideService(Clock.Clock, timeline.clock),
      );
    const assertion = assertAuthenticationAdmission(reusable, {
      ...boundInput,
      bindingRevision: 1,
    });
    const [first, second] = yield* Effect.all([Effect.exit(assertion), Effect.exit(assertion)], { concurrency: 2 });
    expect([first, second].filter(Exit.isSuccess)).toHaveLength(1);
    const rerun = yield* Effect.exit(assertion);
    expect(Exit.isFailure(rerun)).toBe(true);
  }),
);

it.effect('uses the composition-owned admission deadline bound', () =>
  Effect.gen(function* configuredDeadline() {
    const timeline = makeAdmissionClock(now);
    const trusted = makeTrustedAuthenticationAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 100,
    });
    const observer: TrustedAdmissionObservationService = {
      observeAuthentication: (request) =>
        Effect.succeed(
          Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            bindingRevision: 1,
            expiresAt: DateTime.add(now, { milliseconds: 1000 }),
            nonce: request.nonce,
            observedAt: now,
            operationRef: request.operationRef,
            principalId: request.principalId,
            tenantId: request.tenantId,
          }),
        ),
      observeExternalSubject: () => Effect.succeed(preBindingObservation),
    };
    const failure = yield* Effect.flip(
      trusted
        .verify({
          audience,
          authBindingId,
          authContextRef: 'opaque-provider-context',
          authenticationNamespaceId: namespaceId,
          nonce: '50000000-0000-4000-8000-000000000003',
          operationRef: 'bounded-operation',
          principalId: PrincipalIdSchema.make(principal.principalId),
          subjectType: 'user',
          tenantId: TenantIdSchema.make(principal.tenantId),
        })
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(TrustedAdmissionObservation, observer),
          Effect.provideService(Clock.Clock, timeline.clock),
        ),
    );
    expect(failure.code).toBe('identity_invalid');
  }),
);

it.effect('accepts a third namespace with a composed bound larger than five seconds', () =>
  Effect.gen(function* thirdNamespaceBound() {
    const timeline = makeAdmissionClock(now);
    const trusted = makeTrustedAuthenticationAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 10_000,
    });
    const observer: TrustedAdmissionObservationService = {
      observeAuthentication: (request) =>
        Effect.succeed(
          Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            bindingRevision: 3,
            expiresAt: DateTime.add(now, { milliseconds: 6000 }),
            nonce: request.nonce,
            observedAt: now,
            operationRef: request.operationRef,
            principalId: request.principalId,
            tenantId: request.tenantId,
          }),
        ),
      observeExternalSubject: () => Effect.succeed(preBindingObservation),
    };
    const request = {
      audience,
      authBindingId,
      authContextRef: 'opaque-other-provider-context',
      authenticationNamespaceId: wideNamespaceId,
      nonce: '50000000-0000-4000-8000-000000000004',
      operationRef: 'third-namespace-operation',
      principalId: PrincipalIdSchema.make(principal.principalId),
      subjectType: 'user' as const,
      tenantId: TenantIdSchema.make(principal.tenantId),
    };
    const admission = yield* trusted
      .verify(request)
      .pipe(
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provideService(TrustedAdmissionObservation, observer),
        Effect.provideService(Clock.Clock, timeline.clock),
      );
    yield* assertAuthenticationAdmission(admission, {
      ...request,
      bindingRevision: 3,
    });
  }),
);

it.effect('rechecks each Tenant binding while a shared provider context remains unchanged', () =>
  Effect.gen(function* tenantBindingIsolation() {
    const tenantTwoPrincipal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      ...principal,
      authBindingId: '10000000-0000-4000-8000-000000000004',
      principalId: '10000000-0000-4000-8000-000000000005',
      tenantId: '10000000-0000-4000-8000-000000000006',
    });
    const makeRecord = (candidate: typeof principal): PersistedScopeRecord => ({
      ...activeRecord,
      bindingAuthenticationNamespaceId: candidate.authenticationNamespaceId ?? null,
      bindingPrincipalId: candidate.principalId,
      bindingRevision: 1,
      bindingTenantId: candidate.tenantId,
      principalTenantId: candidate.tenantId,
    });
    const records = new Map([
      [principal.tenantId, makeRecord(principal)],
      [tenantTwoPrincipal.tenantId, makeRecord(tenantTwoPrincipal)],
    ]);
    const coreLoads: string[] = [];
    const providerCalls: { readonly authContextRef: string; readonly tenantId: string }[] = [];
    const providerState = {
      accountStatus: 'active',
      businessGrantStatus: 'active',
      sessionStatus: 'active',
    } as const;
    const providerSnapshots: (typeof providerState)[] = [];
    const timeline = makeAdmissionClock(now);
    const trusted = makeTrustedAuthenticationAdmissionService({
      attesterPrincipalId,
      maxAdmissionWindowMillis: 5000,
    });
    const observer: TrustedAdmissionObservationService = {
      observeAuthentication: (request) =>
        Effect.succeed(
          Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            bindingRevision: 1,
            expiresAt: DateTime.add(now, { milliseconds: 1000 }),
            nonce: request.nonce,
            observedAt: now,
            operationRef: request.operationRef,
            principalId: request.principalId,
            tenantId: request.tenantId,
          }),
        ),
      observeExternalSubject: () => Effect.succeed(preBindingObservation),
    };
    const authentication: typeof ExternalOperationAuthentication.Service = {
      verify: (request) => {
        providerCalls.push({ authContextRef: request.authContextRef, tenantId: request.tenantId });
        providerSnapshots.push({ ...providerState });
        return trusted
          .verify({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            nonce: request.nonce,
            operationRef: request.operationRef,
            principalId: request.principalId,
            subjectType: request.subjectType,
            tenantId: request.tenantId,
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provideService(TrustedAdmissionObservation, observer),
            Effect.provideService(Clock.Clock, timeline.clock),
            Effect.mapError(operationError),
          );
      },
    };
    const resolver = makeOperationalScopeResolver(
      {
        load: (candidate) =>
          Effect.sync(() => {
            coreLoads.push(candidate.tenantId);
            return records.get(candidate.tenantId) ?? makeRecord(candidate);
          }),
      },
      access,
    );
    const resolve = (candidate: typeof principal, correlationId: string) =>
      resolver
        .resolve({
          ...input,
          correlationId,
          principal: candidate,
        })
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(ExternalOperationAuthentication, authentication),
        );

    yield* resolve(principal, 'tenant-one-before-revoke');
    yield* resolve(tenantTwoPrincipal, 'tenant-two-before-revoke');
    const providerStateBeforeRevoke = providerSnapshots.map((snapshot) => ({ ...snapshot }));

    records.set(principal.tenantId, {
      ...makeRecord(principal),
      bindingRevokedAt: DateTime.toDateUtc(now),
      bindingStatus: 'revoked',
    });
    const tenantOneDenied = yield* resolve(principal, 'tenant-one-after-revoke').pipe(Effect.flip);
    expect(tenantOneDenied).toBeInstanceOf(OperationAuthenticationRequired);
    yield* resolve(tenantTwoPrincipal, 'tenant-two-after-revoke');

    expect(coreLoads).toEqual([
      principal.tenantId,
      tenantTwoPrincipal.tenantId,
      principal.tenantId,
      tenantTwoPrincipal.tenantId,
    ]);
    expect(providerCalls.map(({ authContextRef, tenantId }) => ({ authContextRef, tenantId }))).toEqual([
      { authContextRef: 'opaque-provider-context', tenantId: principal.tenantId },
      { authContextRef: 'opaque-provider-context', tenantId: tenantTwoPrincipal.tenantId },
      { authContextRef: 'opaque-provider-context', tenantId: principal.tenantId },
      { authContextRef: 'opaque-provider-context', tenantId: tenantTwoPrincipal.tenantId },
    ]);
    expect(providerSnapshots).toEqual([...providerStateBeforeRevoke, { ...providerState }, { ...providerState }]);
  }),
);
