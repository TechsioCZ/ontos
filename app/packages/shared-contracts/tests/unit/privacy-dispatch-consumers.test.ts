import { ConfigProvider, Crypto, Effect, Option, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { GatewayDelegationSourceError, acquireDelegatedGatewayContext } from '../../src/gateway-context-server.ts';
import type { GatewayPrivacyDispatchOperationSchema } from '../../src/gateway-context.ts';
import {
  decodeSupportedGatewayContextClaims,
  privacyDispatchAuthorityPolicy,
  privacyDispatchOperationContract,
} from '../../src/gateway-context.ts';
import {
  PrivacyDispatchContinuationPayloadSchema,
  privacyDispatchConsumerOf,
  privacyDispatchConsumerOfContinuationWorker,
  privacyDispatchConsumerOfOperation,
  privacyDispatchConsumers,
  privacyDispatchOperationFitsConsumer,
} from '../../src/privacy-dispatch-consumers.ts';

const symmyWorker = 'integration.symmy.symmy-job-privacy-dispatch';
const communicationsWorker = 'communications.core.receive-privacy-measure';
const continuationWorker = 'communications.core.report-privacy-owner-outcome';
const tenantId = '30000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const dispatchInvocationId = '30000000-0000-4000-8000-000000000004';
const compositionRevision = 'a'.repeat(64);
const symmyKey = 'privacy.core.requirement.symmy-owner-execution-outcome';
const communicationsKey = 'privacy.core.requirement.communications-owner-execution-outcome';

const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_GATEWAY_MODULE_API_KEY: 'fixture-module-credential',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});
const fetchOk: typeof globalThis.fetch = () =>
  Promise.resolve(Response.json({ apiBaseUrl: '/x', compositionRevision, expiresAt: 1_700_000_300, token: 't' }));

const nativeEvidence = {
  deliveryId: '30000000-0000-4000-8000-000000000005',
  dispatchInvocationId,
  domainEventId: '30000000-0000-4000-8000-000000000006',
  governanceLegalEntityId: legalEntityId,
  handoffHash: 'b'.repeat(64),
  measureId: 'native-measure',
  messageId: '30000000-0000-4000-8000-000000000007',
  principalId,
  requestHash: 'c'.repeat(64),
  taskId: 'native-task',
  tenantId,
};
const claimsOf = (privacyDispatch: DispatchEvidence, aud: string, ver = 5) => ({
  act: { appId: 'privacy', buildMarker: 'privacy-native', principalId: '30000000-0000-4000-8000-000000000008' },
  aud,
  compositionRevision,
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: '30000000-0000-4000-8000-000000000009',
  principal: {
    authBindingId: '30000000-0000-4000-8000-000000000010',
    authContextRef: 'better-auth-session:native',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  },
  privacyDispatch,
  sub: principalId,
  targetBuildMarker: 'consumer-native',
  ver,
});
type DispatchEvidence = Readonly<Record<string, string | ReturnType<typeof privacyDispatchOperationContract>>>;
const worker = (operation: string, workerKey: string, workerModuleKey: string) => ({
  ...nativeEvidence,
  claimId: 'claim',
  operation,
  sourceMode: 'worker',
  workerKey,
  workerModuleKey,
});
const accepted = (claims: ReturnType<typeof claimsOf>) =>
  decodeSupportedGatewayContextClaims(claims).pipe(Effect.result, Effect.map(Result.isSuccess));

it('names every approved consumer once, keyed by its module id, with distinct workers and receipts', () => {
  const consumers = Object.entries(privacyDispatchConsumers);
  expect(consumers.map(([moduleKey]) => moduleKey).toSorted()).toEqual(['communications.core', 'integration.symmy']);
  for (const [moduleKey, consumer] of consumers) {
    expect(consumer.moduleKey).toBe(moduleKey);
  }
  const communications = privacyDispatchConsumers['communications.core'];
  expect(communications).toEqual({
    appId: 'communications',
    continuation: {
      actionKey: 'communications.core.record-owner-execution-evidence',
      requirementKey: 'communications.core.requirement.privacy-report-recorded-owner-outcome',
      topic: 'communications.core.owner-execution-evidence-recorded.v1',
      workerKey: continuationWorker,
    },
    moduleKey: 'communications.core',
    receiptOperation: 'CommunicationsReceipt',
    receiptRequirementKey: communicationsKey,
    workerKey: communicationsWorker,
  });
  // Communications never executes a measure: it has a receipt Read and no execution operation.
  expect(communications?.executionOperation).toBeUndefined();
  expect(new Set(consumers.map(([, { workerKey }]) => workerKey)).size).toBe(consumers.length);
  expect(new Set(consumers.map(([, { receiptRequirementKey }]) => receiptRequirementKey)).size).toBe(consumers.length);
});

it('finds a dispatch consumer by its worker, else by the receipt it reads, and never across consumers', () => {
  expect(privacyDispatchConsumerOf({ operation: 'PrivacyOutcome', workerKey: communicationsWorker })?.moduleKey).toBe(
    'communications.core',
  );
  expect(privacyDispatchConsumerOf({ operation: 'PrivacyOutcome', workerKey: symmyWorker })?.moduleKey).toBe(
    'integration.symmy',
  );
  expect(privacyDispatchConsumerOf({ operation: 'CommunicationsReceipt' })?.moduleKey).toBe('communications.core');
  expect(privacyDispatchConsumerOf({ operation: 'SymmyReceipt' })?.moduleKey).toBe('integration.symmy');
  // a Communications worker cannot carry a Symmy operation and vice versa
  expect(privacyDispatchConsumerOf({ operation: 'SymmyReceipt', workerKey: communicationsWorker })).toBeUndefined();
  expect(privacyDispatchConsumerOf({ operation: 'SymmyRetention', workerKey: communicationsWorker })).toBeUndefined();
  expect(privacyDispatchConsumerOf({ operation: 'CommunicationsReceipt', workerKey: symmyWorker })).toBeUndefined();
  // an operation no consumer owns needs its worker, and an unknown worker belongs to nobody
  expect(privacyDispatchConsumerOf({ operation: 'PrivacyOutcome' })).toBeUndefined();
  expect(privacyDispatchConsumerOf({ operation: 'PrivacyOutcome', workerKey: 'other.worker' })).toBeUndefined();
  // only a receipt is a durable read: Symmy's own execution has none
  expect(privacyDispatchConsumerOf({ operation: 'SymmyRetention' })).toBeUndefined();
  const communications = privacyDispatchConsumers['communications.core'];
  expect(
    communications === undefined
      ? undefined
      : privacyDispatchOperationFitsConsumer(communications, 'PrivacyEligibility'),
  ).toBe(true);
  expect(privacyDispatchConsumerOfOperation('PrivacyEligibility')).toBeUndefined();
});

it('derives the Communications authority from the approved consumer: its own receipt at tenant scope', () => {
  expect(Option.getOrUndefined(privacyDispatchAuthorityPolicy({ operation: 'CommunicationsReceipt' }))).toEqual({
    consumerModuleKey: 'communications.core',
    originActionKey: 'privacy.core.dispatch-privacy-measure',
    originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
    producerModuleKey: 'privacy.core',
    subjectResourceType: 'privacy.core.privacy-measure',
    targetAccess: 'tenant-scope',
    topic: 'privacy.measure.dispatched',
    workerKey: communicationsWorker,
  });
  expect(
    Option.getOrUndefined(
      privacyDispatchAuthorityPolicy({ operation: 'PrivacyOutcome', workerKey: communicationsWorker }),
    ),
  ).toEqual({
    consumerModuleKey: 'communications.core',
    originActionKey: 'privacy.core.dispatch-privacy-measure',
    originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
    producerModuleKey: 'privacy.core',
    subjectResourceType: 'privacy.core.privacy-measure',
    targetAccess: 'delegated-actor',
    topic: 'privacy.measure.dispatched',
    workerKey: communicationsWorker,
  });
  expect(privacyDispatchOperationContract('CommunicationsReceipt')).toEqual({
    access: 'read',
    appId: 'communications',
    declarationKey: 'communications.core.privacy-owner-execution-outcome.read',
    entrypointKey: 'communications.core.api.privacy-owner-execution-outcome',
    legalEntityScope: 'optional',
    moduleId: 'communications.core',
    schemaVersion: '1',
  });
  // a cross-consumer or ownerless dispatch has no authority at all
  expect(
    Option.isNone(privacyDispatchAuthorityPolicy({ operation: 'SymmyReceipt', workerKey: communicationsWorker })),
  ).toBe(true);
  expect(
    Option.isNone(privacyDispatchAuthorityPolicy({ operation: 'CommunicationsReceipt', workerKey: symmyWorker })),
  ).toBe(true);
  expect(Option.isNone(privacyDispatchAuthorityPolicy({ operation: 'PrivacyOutcome' }))).toBe(true);
});

it.effect('accepts a Communications claim only for Communications and a Symmy claim only for Symmy', () =>
  Effect.gen(function* consumerClaims() {
    expect(
      yield* accepted(
        claimsOf(worker('CommunicationsReceipt', communicationsWorker, 'communications.core'), 'communications'),
      ),
    ).toBe(true);
    expect(
      yield* accepted(claimsOf(worker('PrivacyOutcome', communicationsWorker, 'communications.core'), 'privacy')),
    ).toBe(true);
    expect(
      yield* accepted(
        claimsOf({ ...nativeEvidence, operation: 'CommunicationsReceipt', sourceMode: 'dispatch' }, 'communications'),
      ),
    ).toBe(true);
    for (const [privacyDispatch, aud] of [
      // a Communications worker cannot use a Symmy operation, and a Symmy worker cannot use a Communications one
      [worker('SymmyReceipt', communicationsWorker, 'communications.core'), 'symmy-integration'],
      [worker('SymmyRetention', communicationsWorker, 'communications.core'), 'symmy-integration'],
      [worker('CommunicationsReceipt', symmyWorker, 'integration.symmy'), 'communications'],
      // a worker of one consumer cannot be labelled as another consumer's module
      [worker('CommunicationsReceipt', communicationsWorker, 'integration.symmy'), 'communications'],
      [worker('SymmyReceipt', symmyWorker, 'communications.core'), 'symmy-integration'],
      // a durable read admits only a receipt, and only for its own audience
      [{ ...nativeEvidence, operation: 'PrivacyOutcome', sourceMode: 'dispatch' }, 'privacy'],
      [{ ...nativeEvidence, operation: 'CommunicationsReceipt', sourceMode: 'dispatch' }, 'symmy-integration'],
      [{ ...nativeEvidence, operation: 'SymmyReceipt', sourceMode: 'dispatch' }, 'communications'],
      [worker('CommunicationsReceipt', communicationsWorker, 'communications.core'), 'privacy'],
    ] as const) {
      expect(yield* accepted(claimsOf(privacyDispatch, aud))).toBe(false);
    }
  }),
);

it.effect('signs a versioned Communications target only with its approved operation identity', () =>
  Effect.gen(function* versionedTarget() {
    const target = privacyDispatchOperationContract('CommunicationsReceipt');
    const signed = (signedTarget: typeof target) =>
      claimsOf(
        {
          ...worker('CommunicationsReceipt', communicationsWorker, 'communications.core'),
          target: signedTarget,
        },
        'communications',
        7,
      );
    expect(yield* accepted(signed({ ...target, schemaVersion: '2' }))).toBe(true);
    for (const forged of [
      { ...target, entrypointKey: 'integration.symmy.api.symmy-job-privacy-execution' },
      { ...target, declarationKey: 'integration.symmy.privacy-measure.read-receipt' },
      { ...target, appId: 'symmy-integration' },
      { ...target, legalEntityScope: 'required' as const },
    ]) {
      expect(yield* accepted(signed(forged))).toBe(false);
    }
  }),
);

const decide = (
  operation: typeof GatewayPrivacyDispatchOperationSchema.Type,
  audience: string,
  operationRequirementKey?: string,
  legalEntityScope: 'subject' | 'tenant' = 'subject',
) => {
  const intent = {
    _tag: 'PrivacyDispatch',
    operation,
    source: { _tag: 'Dispatch', compositionRevision, dispatchInvocationId, legalEntityId, tenantId },
  } as const;
  return acquireDelegatedGatewayContext(
    {
      audience,
      legalEntityScope,
      requestCorrelation: 'consumer-contract',
      subject: operationRequirementKey === undefined ? intent : { ...intent, operationRequirementKey },
    },
    crypto,
  ).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, configuration),
    Effect.provideService(FetchHttpClient.Fetch, fetchOk),
    Effect.result,
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        return 'accept';
      }
      return Schema.is(GatewayDelegationSourceError)(result.failure) ? result.failure.reason : 'other';
    }),
  );
};

it.effect('lets the durable receipt read name only its own consumer receipt and its own requirement', () =>
  Effect.gen(function* durableReceipts() {
    expect(yield* decide({ _tag: 'CommunicationsReceipt', attempt: 1 }, 'communications', communicationsKey)).toBe(
      'accept',
    );
    expect(yield* decide({ _tag: 'CommunicationsReceipt' }, 'communications', communicationsKey)).toBe('accept');
    expect(yield* decide({ _tag: 'SymmyReceipt', attempt: 1 }, 'symmy-integration', symmyKey)).toBe('accept');
    const exactContract = 'Durable Privacy dispatch requires its exact receipt contract';
    // neither consumer's receipt can borrow the other's requirement, and neither can read without one
    expect(yield* decide({ _tag: 'CommunicationsReceipt' }, 'communications', symmyKey)).toBe(exactContract);
    expect(yield* decide({ _tag: 'SymmyReceipt' }, 'symmy-integration', communicationsKey)).toBe(exactContract);
    expect(yield* decide({ _tag: 'CommunicationsReceipt' }, 'communications')).toBe(exactContract);
    // a durable read permits only a receipt, and only toward the audience that owns that receipt
    const onlyReceipt = 'Durable Privacy dispatch permits only its exact receipt operation';
    expect(yield* decide({ _tag: 'PrivacyOutcome', attempt: 1 }, 'privacy', communicationsKey)).toBe(onlyReceipt);
    expect(yield* decide({ _tag: 'PrivacyEligibility' }, 'privacy', communicationsKey)).toBe(onlyReceipt);
    const exactScope = 'Finite Privacy dispatch requires its exact operation and governance scope';
    expect(yield* decide({ _tag: 'CommunicationsReceipt' }, 'symmy-integration', communicationsKey)).toBe(exactScope);
    expect(yield* decide({ _tag: 'SymmyReceipt' }, 'communications', symmyKey)).toBe(exactScope);
    expect(yield* decide({ _tag: 'CommunicationsReceipt' }, 'communications', communicationsKey, 'tenant')).toBe(
      exactScope,
    );
  }),
);

const continuation = (overrides: Readonly<Record<string, string>> = {}) => ({
  ...nativeEvidence,
  claimId: 'continuation-claim',
  continuationDeliveryId: '30000000-0000-4000-8000-000000000011',
  operation: 'PrivacyOutcome',
  sourceMode: 'continuation',
  workerKey: continuationWorker,
  workerModuleKey: 'communications.core',
  ...overrides,
});

it('gives only Communications a continuation, whose worker is neither consumer worker and carries only an outcome', () => {
  expect(privacyDispatchConsumerOfContinuationWorker(continuationWorker)?.moduleKey).toBe('communications.core');
  // Symmy stays frozen: it has no continuation, so none of its workers (nor any consumer worker) is one
  expect(privacyDispatchConsumers['integration.symmy']?.continuation).toBeUndefined();
  for (const workerKey of [symmyWorker, communicationsWorker, 'other.worker', undefined]) {
    expect(privacyDispatchConsumerOfContinuationWorker(workerKey)).toBeUndefined();
  }
  expect(
    privacyDispatchConsumerOf({
      operation: 'PrivacyOutcome',
      sourceMode: 'continuation',
      workerKey: continuationWorker,
    })?.moduleKey,
  ).toBe('communications.core');
  for (const operation of ['CommunicationsReceipt', 'PrivacyEligibility', 'SymmyReceipt', 'SymmyRetention'] as const) {
    expect(
      privacyDispatchConsumerOf({ operation, sourceMode: 'continuation', workerKey: continuationWorker }),
    ).toBeUndefined();
  }
  // a consumer worker is not a continuation, and a continuation worker is not a consumer worker
  expect(
    privacyDispatchConsumerOf({ operation: 'PrivacyOutcome', sourceMode: 'continuation', workerKey: symmyWorker }),
  ).toBeUndefined();
  expect(
    privacyDispatchConsumerOf({
      operation: 'PrivacyOutcome',
      sourceMode: 'continuation',
      workerKey: communicationsWorker,
    }),
  ).toBeUndefined();
  expect(privacyDispatchConsumerOf({ operation: 'PrivacyOutcome', workerKey: continuationWorker })).toBeUndefined();
});

it('derives the continuation authority from the approved consumer and adds it only to a continuation', () => {
  expect(
    Option.getOrUndefined(
      privacyDispatchAuthorityPolicy({
        operation: 'PrivacyOutcome',
        sourceMode: 'continuation',
        workerKey: continuationWorker,
      }),
    ),
  ).toEqual({
    consumerModuleKey: 'communications.core',
    continuation: {
      actionKey: 'communications.core.record-owner-execution-evidence',
      topic: 'communications.core.owner-execution-evidence-recorded.v1',
      workerKey: continuationWorker,
    },
    originActionKey: 'privacy.core.dispatch-privacy-measure',
    originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
    producerModuleKey: 'privacy.core',
    subjectResourceType: 'privacy.core.privacy-measure',
    targetAccess: 'delegated-actor',
    topic: 'privacy.measure.dispatched',
    workerKey: communicationsWorker,
  });
  expect(
    Option.getOrUndefined(
      privacyDispatchAuthorityPolicy({
        operation: 'PrivacyOutcome',
        sourceMode: 'worker',
        workerKey: communicationsWorker,
      }),
    )?.continuation,
  ).toBeUndefined();
  expect(
    Option.isNone(
      privacyDispatchAuthorityPolicy({
        operation: 'PrivacyOutcome',
        sourceMode: 'continuation',
        workerKey: symmyWorker,
      }),
    ),
  ).toBe(true);
});

it.effect('accepts a continuation claim only as one Communications outcome report with its continuation delivery', () =>
  Effect.gen(function* continuationClaims() {
    expect(yield* accepted(claimsOf(continuation(), 'privacy'))).toBe(true);
    const { continuationDeliveryId: _delivery, ...withoutDelivery } = continuation();
    const { claimId: _claim, ...withoutClaim } = continuation();
    for (const [privacyDispatch, aud] of [
      // a continuation reports exactly one Privacy outcome: no receipt, eligibility or Symmy operation
      [continuation({ operation: 'CommunicationsReceipt' }), 'communications'],
      [continuation({ operation: 'PrivacyEligibility' }), 'privacy'],
      [continuation({ operation: 'SymmyReceipt' }), 'symmy-integration'],
      // only the Communications continuation worker, labelled as Communications, under its current claim
      [continuation({ workerKey: symmyWorker }), 'privacy'],
      [continuation({ workerKey: communicationsWorker }), 'privacy'],
      [continuation({ workerModuleKey: 'integration.symmy' }), 'privacy'],
      [withoutDelivery, 'privacy'],
      [withoutClaim, 'privacy'],
      // a worker or a durable read never names a continuation delivery
      [
        {
          ...worker('PrivacyOutcome', communicationsWorker, 'communications.core'),
          continuationDeliveryId: '30000000-0000-4000-8000-000000000011',
        },
        'privacy',
      ],
      [continuation(), 'communications'],
    ] as const) {
      expect(yield* accepted(claimsOf(privacyDispatch, aud))).toBe(false);
    }
  }),
);

it('lets a continuation payload name only the original dispatch and an attempt after the take-over report', () => {
  const valid = { attempt: 2, dispatchInvocationId, measureId: 'FICTIONAL-measure', taskId: 'FICTIONAL-task' };
  expect(Schema.is(PrivacyDispatchContinuationPayloadSchema)(valid)).toBe(true);
  for (const invalid of [
    { ...valid, attempt: 1 },
    { ...valid, attempt: 2.5 },
    { ...valid, dispatchInvocationId: 'not-a-uuid' },
    { ...valid, measureId: '' },
  ]) {
    expect(Schema.is(PrivacyDispatchContinuationPayloadSchema)(invalid)).toBe(false);
  }
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(PrivacyDispatchContinuationPayloadSchema, { onExcessProperty: 'error' })({
        ...valid,
        outcome: 'SUCCEEDED',
      }),
    ),
  ).toBe(true);
});
