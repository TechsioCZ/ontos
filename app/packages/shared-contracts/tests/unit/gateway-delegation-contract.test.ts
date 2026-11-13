import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { ConfigProvider, Crypto, Effect, Match, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../core-runtime/tests/support/module-credentials.ts';
import { GatewayDelegationSourceError, acquireDelegatedGatewayContext } from '../../src/gateway-context-server.ts';
import { GatewayDelegatedContextRequestSchema } from '../../src/gateway-context.ts';

type DecodedSubject = Schema.Schema.Type<typeof GatewayDelegatedContextRequestSchema>['subject'];

const compositionRevision = 'a'.repeat(64);
const originatorInvocationId = '80000000-0000-4000-8000-000000000001';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:delegation-contract',
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
});
const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
/** The calling module's key, handed over the way the host does. */
const holdCallerKey = holdTestModuleCredentials({ catalog: 'fixture-module-credential' });
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});

const makeWorkerContext = (legalEntityScope: 'forbidden' | 'required' = 'forbidden') =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'worker-native-claim',
    compositionRevision,
    consumerModuleKey: 'integration.source',
    deliveryId: '70000000-0000-4000-8000-000000000001',
    domainEventId: '70000000-0000-4000-8000-000000000002',
    legalEntityScope,
    messageId: '70000000-0000-4000-8000-000000000003',
    producerModuleKey: 'integration.source',
    tenantId: principal.tenantId,
    tenantSequenceNo: 1n,
    topic: 'integration.source.job-admitted.v1',
    workerKey: 'integration.source.execute-job',
  });

const recordingFetch =
  (revision: string, requests: Request[]): typeof globalThis.fetch =>
  (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      Response.json({
        apiBaseUrl: '/party-registry-api',
        compositionRevision: revision,
        expiresAt: 1_700_000_300,
        token: 'fixture-destination-assertion',
      }),
    );
  };

const sourceAssertionOf = (subject: DecodedSubject): string | null =>
  Match.value(subject).pipe(
    Match.tag('Assertion', (assertion) => Redacted.value(assertion.sourceAssertion)),
    Match.tag('Originator', () => null),
    Match.orElse(() => null),
  );

const originatorOf = (subject: DecodedSubject) =>
  Match.value(subject).pipe(
    Match.tag('Assertion', () => null),
    Match.tag('Originator', ({ actionInvocationId, tenantId }) => ({ actionInvocationId, tenantId })),
    Match.orElse(() => null),
  );

const requestBodyOf = (request: Request | undefined) =>
  Effect.promise(() => (request ?? new Request('https://invalid.example')).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
  );

it.effect('decodes both subject variants and keeps the source assertion redacted', () =>
  Effect.gen(function* delegatedSubjectCodec() {
    const assertionWire = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000001',
      legalEntityScope: 'subject',
      subject: { _tag: 'Assertion', sourceAssertion: 'fixture-signed-source-proof' },
    };
    const decoded = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, {
      onExcessProperty: 'error',
    })(assertionWire);
    expect(sourceAssertionOf(decoded.subject)).toBe('fixture-signed-source-proof');
    expect(
      Match.value(decoded.subject).pipe(
        Match.tag('Assertion', (assertion) => Redacted.isRedacted(assertion.sourceAssertion)),
        Match.tag('Originator', () => false),
        Match.orElse(() => null),
      ),
    ).toBe(true);
    const encoded = yield* Schema.encodeEffect(GatewayDelegatedContextRequestSchema)(decoded);
    expect(encoded).toEqual(assertionWire);

    const originatorWire = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000002',
      legalEntityScope: 'tenant',
      subject: {
        _tag: 'Originator',
        actionInvocationId: originatorInvocationId,
        tenantId: principal.tenantId,
      },
    };
    const originator = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, {
      onExcessProperty: 'error',
    })(originatorWire);
    expect(originatorOf(originator.subject)).toEqual({
      actionInvocationId: originatorInvocationId,
      tenantId: principal.tenantId,
    });
    expect(originator.legalEntityScope).toBe('tenant');
  }),
);

it.effect('rejects unknown subject tags, extra fields, and malformed identities', () =>
  Effect.gen(function* delegatedSubjectRejection() {
    const base = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000001',
      legalEntityScope: 'subject',
    };
    const decode = Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, { onExcessProperty: 'error' });
    const invalid: readonly unknown[] = [
      { ...base, subject: { _tag: 'System', jobKey: 'job' } },
      {
        ...base,
        subject: { _tag: 'Assertion', actionInvocationId: originatorInvocationId, sourceAssertion: 'proof' },
      },
      {
        ...base,
        subject: { _tag: 'Originator', actionInvocationId: 'not-a-uuid', tenantId: principal.tenantId },
      },
      { ...base, subject: { _tag: 'Originator', actionInvocationId: originatorInvocationId } },
      {
        ...base,
        operationKey: 'party.registry.api.party-detail',
        subject: { _tag: 'Assertion', sourceAssertion: 'proof' },
      },
      { ...base, legalEntityScope: 'organization', subject: { _tag: 'Assertion', sourceAssertion: 'proof' } },
    ];
    for (const payload of invalid) {
      expect(yield* Effect.flip(decode(payload))).toBeDefined();
    }
  }),
);

it.effect('authenticates with the module credential and sends the Originator subject', () =>
  Effect.gen(function* delegatedOriginatorWire() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'delegation-wire-correlation',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originatorInvocationId,
          compositionRevision,
          tenantId: principal.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );

    expect(issued).toEqual({
      apiBaseUrl: 'https://shell.example.test/party-registry-api',
      authorization: 'Bearer fixture-destination-assertion',
      compositionRevision,
      expiresAt: 1_700_000_300,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context');
    expect(request?.headers.get('x-api-key')).toBe('fixture-module-credential');
    expect(request?.headers.get('x-correlation-id')).toBe('delegation-wire-correlation');
    expect(request?.headers.get('authorization')).toBeNull();
    const wire = yield* requestBodyOf(request);
    expect(wire.audience).toBe('party-registry');
    expect(wire.compositionRevision).toBe(compositionRevision);
    expect(wire.legalEntityScope).toBe('tenant');
    expect(originatorOf(wire.subject)).toEqual({
      actionInvocationId: originatorInvocationId,
      tenantId: principal.tenantId,
    });
  }),
);

it.effect('sends the verified incoming assertion and the requested legal entity for an Assertion subject', () =>
  Effect.gen(function* delegatedAssertionWire() {
    yield* holdCallerKey;
    const scope = trustVerifiedGatewayPrincipalContext(principal, compositionRevision, {
      assertion: Redacted.make('fixture-signed-source-proof'),
      audience: 'commerce-market-catalog',
    });
    const requests: Request[] = [];
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-assertion-correlation',
        subject: { _tag: 'Assertion', scope },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );

    expect(issued.authorization).toBe('Bearer fixture-destination-assertion');
    const wire = yield* requestBodyOf(requests[0]);
    expect(wire.legalEntityScope).toBe('subject');
    expect(sourceAssertionOf(wire.subject)).toBe('fixture-signed-source-proof');
  }),
);

it.effect('fails typed without requests when an Assertion subject has no verified scope', () =>
  Effect.gen(function* delegatedMissingScope() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-missing-scope',
        subject: { _tag: 'Assertion', scope: principal },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      Effect.flip,
    );

    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('refuses a response for a different admitted release', () =>
  Effect.gen(function* delegatedRevisionChange() {
    yield* holdCallerKey;
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-revision-change',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originatorInvocationId,
          compositionRevision,
          tenantId: principal.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch('b'.repeat(64), [])),
      Effect.flip,
    );

    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
  }),
);

it.effect('preserves the recorded executor pin on the actual worker and admission HTTP requests', () =>
  Effect.gen(function* registeredPinWire() {
    yield* holdCallerKey;
    const expectedPrincipalId = '90000000-0000-4000-8000-000000000001';
    const context = makeWorkerContext();
    const requests: Request[] = [];
    for (const subject of [
      {
        _tag: 'RegisteredWorkload' as const,
        context,
        declarationKey: 'party.registry.party.create',
        expectedPrincipalId,
      },
      {
        _tag: 'RegisteredAdmission' as const,
        actionInvocationId: originatorInvocationId,
        compositionRevision,
        declarationKey: 'party.registry.party.create',
        expectedPrincipalId,
        operationRequirementKey: 'integration.source.requirement.sync-party',
        sourceActionKey: 'integration.source.admit-sync',
        tenantId: principal.tenantId,
      },
    ]) {
      yield* acquireDelegatedGatewayContext(
        {
          audience: 'party-registry',
          callingAppId: 'catalog',
          legalEntityScope: 'tenant',
          requestCorrelation: 'executor-pin-wire',
          subject,
        },
        crypto,
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      );
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const wire = yield* requestBodyOf(request);
      expect(
        Match.value(wire.subject).pipe(
          Match.tag('RegisteredWorkload', (subject) => subject.expectedPrincipalId),
          Match.tag('RegisteredAdmission', (subject) => subject.expectedPrincipalId),
          Match.orElse(() => {}),
        ),
      ).toBe(expectedPrincipalId);
      yield* Match.value(wire.subject).pipe(
        Match.tag('RegisteredAdmission', (subject) =>
          Effect.sync(() => {
            expect(subject.operationRequirementKey).toBe('integration.source.requirement.sync-party');
          }),
        ),
        Match.orElse(() => Effect.void),
      );
    }
  }),
);

it.effect('sends a company-scoped worker delivery only with its company for Shell to bind to the admission', () =>
  Effect.gen(function* companyScopedWorkerWire() {
    yield* holdCallerKey;
    const legalEntityId = '50000000-0000-4000-8000-000000000001';
    const requests: Request[] = [];
    const acquire = (subject: Parameters<typeof acquireDelegatedGatewayContext>[0]['subject']) =>
      acquireDelegatedGatewayContext(
        {
          audience: 'party-registry',
          callingAppId: 'catalog',
          legalEntityScope: 'subject',
          requestCorrelation: 'company-worker-wire',
          subject,
        },
        crypto,
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      );
    const worker = { _tag: 'RegisteredWorkload' as const, declarationKey: 'party.registry.party.create' };

    const unnamed = yield* Effect.flip(acquire({ ...worker, context: makeWorkerContext('required') }));
    expect(Schema.is(GatewayDelegationSourceError)(unnamed)).toBe(true);
    const copied = yield* Effect.flip(
      acquire({ ...worker, context: { ...makeWorkerContext('required') }, legalEntityId }),
    );
    expect(Schema.is(GatewayDelegationSourceError)(copied)).toBe(true);
    expect(requests).toHaveLength(0);

    yield* acquire({ ...worker, context: makeWorkerContext('required'), legalEntityId });
    expect(requests).toHaveLength(1);
    const wire = yield* requestBodyOf(requests[0]);
    expect(wire.legalEntityScope).toBe('subject');
    expect(
      Match.value(wire.subject).pipe(
        Match.tag('RegisteredWorkload', (subject) => ({
          claimId: subject.claimId,
          deliveryId: subject.deliveryId,
          legalEntityId: subject.legalEntityId,
          tenantId: subject.tenantId,
          workerKey: subject.workerKey,
        })),
        Match.orElse(() => null),
      ),
    ).toEqual({
      claimId: 'worker-native-claim',
      deliveryId: '70000000-0000-4000-8000-000000000001',
      legalEntityId,
      tenantId: principal.tenantId,
      workerKey: 'integration.source.execute-job',
    });
  }),
);

it.effect('sends an explicit historical delivery recovery witness without a claim or admission substitution', () =>
  Effect.gen(function* historicalRecoveryWire() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const deliveryId = '70000000-0000-4000-8000-000000000001';
    yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'historical-delivery-wire',
        subject: {
          _tag: 'RegisteredRecovery',
          declarationKey: 'party.registry.source-recovery.read',
          operationRequirementKey: 'integration.source.requirement.worker-party-recovery',
          originalActionKey: 'party.registry.source-write',
          originalIdempotencyKey: 'original-native-command',
          originalPrincipalId: principal.principalId,
          originalRequestHash: 'b'.repeat(64),
          requestHash: 'c'.repeat(64),
          source: {
            _tag: 'HistoricalDelivery',
            compositionRevision,
            deliveryId,
            tenantId: principal.tenantId,
            workerKey: 'integration.symmy.execute-symmy-job',
          },
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toBeDefined();
    if (request === undefined) {
      return yield* Effect.die('The historical delivery request was not sent');
    }
    const wire = yield* requestBodyOf(request);
    expect(wire.compositionRevision).toBe(compositionRevision);
    yield* Match.value(wire.subject).pipe(
      Match.tag('RegisteredRecovery', ({ operationRequirementKey, source }) =>
        Match.value(source).pipe(
          Match.tag('HistoricalDelivery', (delivery) =>
            Effect.sync(() => {
              expect(operationRequirementKey).toBe('integration.source.requirement.worker-party-recovery');
              expect(delivery.deliveryId).toBe(deliveryId);
              expect(delivery.tenantId).toBe(principal.tenantId);
              expect(delivery.workerKey).toBe('integration.symmy.execute-symmy-job');
              expect(Object.hasOwn(delivery, 'claimId')).toBe(false);
              expect(Object.hasOwn(delivery, 'actionInvocationId')).toBe(false);
            }),
          ),
          Match.orElse(() => Effect.die('The recovery source was substituted')),
        ),
      ),
      Match.orElse(() => Effect.die('The historical witness was not a recovery subject')),
    );
    return yield* Effect.void;
  }),
);

it.effect('refuses conditional delegation outside the actual Core operation lease before HTTP', () =>
  Effect.gen(function* conditionalLeaseRequired() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const scope = trustVerifiedGatewayPrincipalContext(principal, compositionRevision, {
      assertion: Redacted.make('fixture-source-assertion'),
      audience: 'party-registry',
    });
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'privacy',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'conditional-outside-lease',
        subject: {
          _tag: 'RegisteredAssertion',
          declarationKey: 'privacy.core.source-processing-eligibility.read',
          operationRequirementKey: 'party.registry.requirement.actual-source-privacy',
          scope,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      Effect.flip,
    );
    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('refuses conditional worker delegation outside its actual Core worker lease before HTTP', () =>
  Effect.gen(function* conditionalWorkerLeaseRequired() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'conditional-worker-outside-lease',
        subject: {
          _tag: 'RegisteredWorkload',
          context: makeWorkerContext(),
          declarationKey: 'party.registry.party.create',
          operationRequirementKey: 'integration.source.requirement.worker-party',
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      Effect.flip,
    );
    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('round trips only the conditional worker requirement key without a caller supplied witness', () =>
  Effect.gen(function* conditionalWorkerWireCodec() {
    const payload = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000001',
      legalEntityScope: 'tenant',
      subject: {
        _tag: 'RegisteredWorkload',
        claimId: 'worker-claim',
        declarationKey: 'party.registry.party.create',
        deliveryId: '70000000-0000-4000-8000-000000000001',
        operationRequirementKey: 'integration.source.requirement.worker-party',
        tenantId: principal.tenantId,
        workerKey: 'integration.source.execute-job',
      },
    };
    const decode = Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, { onExcessProperty: 'error' });
    const decoded = yield* decode(payload);
    expect(yield* Schema.encodeEffect(GatewayDelegatedContextRequestSchema)(decoded)).toEqual(payload);
    expect(
      yield* Effect.flip(
        decode({ ...payload, subject: { ...payload.subject, operationWitness: { consumerSchemaVersion: '1' } } }),
      ),
    ).toBeDefined();
  }),
);

it.effect('refuses conditional current-worker recovery without its actual live handler lease before HTTP', () =>
  Effect.gen(function* currentWorkerRecoveryRequiresLiveLease() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'closed-worker-recovery',
        subject: {
          _tag: 'RegisteredRecovery',
          declarationKey: 'party.registry.source-recovery.read',
          operationRequirementKey: 'integration.source.requirement.worker-party-recovery',
          originalActionKey: 'party.registry.source-write',
          originalIdempotencyKey: 'original-native-command',
          originalPrincipalId: principal.principalId,
          originalRequestHash: 'b'.repeat(64),
          requestHash: 'c'.repeat(64),
          source: { _tag: 'Worker', context: makeWorkerContext() },
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      Effect.flip,
    );
    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('preserves post-commit admission recovery conditional keys for independent native Shell evidence', () =>
  Effect.gen(function* admissionRecoveryConditionalWire() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'admission-recovery-key',
        subject: {
          _tag: 'RegisteredRecovery',
          declarationKey: 'party.registry.source-recovery.read',
          operationRequirementKey: 'integration.source.requirement.admission-party-recovery',
          originalActionKey: 'party.registry.source-write',
          originalIdempotencyKey: 'original-native-command',
          originalPrincipalId: principal.principalId,
          originalRequestHash: 'b'.repeat(64),
          requestHash: 'c'.repeat(64),
          source: {
            _tag: 'Admission',
            actionInvocationId: originatorInvocationId,
            compositionRevision,
            sourceActionKey: 'integration.source.admit-sync',
            tenantId: principal.tenantId,
          },
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );
    expect(requests).toHaveLength(1);
    const wire = yield* requestBodyOf(requests[0]);
    expect(
      Match.value(wire.subject).pipe(
        Match.tag('RegisteredRecovery', (subject) => subject.operationRequirementKey),
        Match.orElse(() => {}),
      ),
    ).toBe('integration.source.requirement.admission-party-recovery');
  }),
);
