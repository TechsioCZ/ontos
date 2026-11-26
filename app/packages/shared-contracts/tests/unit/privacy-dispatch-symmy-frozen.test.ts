/**
 * Frozen Symmy behaviour of the finite Privacy dispatch authority. Every literal below was recorded from base 6adcc096f
 * BEFORE the authority became per-consumer; the per-consumer registry must keep reproducing them exactly.
 */
import { ConfigProvider, Crypto, Effect, Option, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { GatewayDelegationSourceError, acquireDelegatedGatewayContext } from '../../src/gateway-context-server.ts';
import {
  decodeSupportedGatewayContextClaims,
  privacyDispatchAuthorityPolicy,
  privacyDispatchOperationContract,
} from '../../src/gateway-context.ts';
import { privacyDispatchConsumers } from '../../src/privacy-dispatch-consumers.ts';

const ops = ['SymmyRetention', 'SymmyReceipt', 'PrivacyEligibility', 'PrivacyOutcome'] as const;
const tenantId = '30000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const dispatchInvocationId = '30000000-0000-4000-8000-000000000004';
const compositionRevision = 'a'.repeat(64);
const symmyWorkerKey = 'integration.symmy.symmy-job-privacy-dispatch';
const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_GATEWAY_MODULE_API_KEY: 'k',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});
const fetchOk: typeof globalThis.fetch = () =>
  Promise.resolve(Response.json({ apiBaseUrl: '/x', compositionRevision, expiresAt: 1_700_000_300, token: 't' }));

const base = {
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
const claimsFor = (privacyDispatch: Readonly<Record<string, string>>, audience: string) => ({
  act: { appId: 'privacy', buildMarker: 'privacy-native', principalId: '30000000-0000-4000-8000-000000000008' },
  aud: audience,
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
  targetBuildMarker: 'symmy-native',
  ver: 5,
});

const frozen = {
  accepted: [
    'worker|SymmyRetention|symmy-integration|integration.symmy.symmy-job-privacy-dispatch|integration.symmy',
    'dispatch|SymmyReceipt|symmy-integration',
    'worker|SymmyReceipt|symmy-integration|integration.symmy.symmy-job-privacy-dispatch|integration.symmy',
    'worker|PrivacyEligibility|privacy|integration.symmy.symmy-job-privacy-dispatch|integration.symmy',
    'worker|PrivacyOutcome|privacy|integration.symmy.symmy-job-privacy-dispatch|integration.symmy',
  ],
  contract: [
    [
      'SymmyRetention',
      {
        access: 'write',
        appId: 'symmy-integration',
        declarationKey: 'integration.symmy.symmy-retention.execute',
        entrypointKey: 'integration.symmy.execute-symmy-retention',
        legalEntityScope: 'optional',
        moduleId: 'integration.symmy',
        schemaVersion: '1',
      },
    ],
    [
      'SymmyReceipt',
      {
        access: 'read',
        appId: 'symmy-integration',
        declarationKey: 'integration.symmy.privacy-measure.read-receipt',
        entrypointKey: 'integration.symmy.api.symmy-job-privacy-execution',
        legalEntityScope: 'optional',
        moduleId: 'integration.symmy',
        schemaVersion: '1',
      },
    ],
    [
      'PrivacyEligibility',
      {
        access: 'read',
        appId: 'privacy',
        declarationKey: 'privacy.core.measure-execution-eligibility.read',
        entrypointKey: 'privacy.core.api.measure-execution-eligibility',
        legalEntityScope: 'required',
        moduleId: 'privacy.core',
        schemaVersion: '1',
      },
    ],
    [
      'PrivacyOutcome',
      {
        access: 'write',
        appId: 'privacy',
        declarationKey: 'privacy.core.owner-execution-outcome.record',
        entrypointKey: 'privacy.core.record-owner-execution-outcome',
        legalEntityScope: 'required',
        moduleId: 'privacy.core',
        schemaVersion: '1',
      },
    ],
  ],
  policy: [
    [
      'SymmyRetention',
      {
        consumerModuleKey: 'integration.symmy',
        originActionKey: 'privacy.core.dispatch-privacy-measure',
        originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
        producerModuleKey: 'privacy.core',
        subjectResourceType: 'privacy.core.privacy-measure',
        targetAccess: 'tenant-scope',
        topic: 'privacy.measure.dispatched',
        workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
      },
    ],
    [
      'SymmyReceipt',
      {
        consumerModuleKey: 'integration.symmy',
        originActionKey: 'privacy.core.dispatch-privacy-measure',
        originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
        producerModuleKey: 'privacy.core',
        subjectResourceType: 'privacy.core.privacy-measure',
        targetAccess: 'tenant-unrestricted-list',
        topic: 'privacy.measure.dispatched',
        workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
      },
    ],
    [
      'PrivacyEligibility',
      {
        consumerModuleKey: 'integration.symmy',
        originActionKey: 'privacy.core.dispatch-privacy-measure',
        originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
        producerModuleKey: 'privacy.core',
        subjectResourceType: 'privacy.core.privacy-measure',
        targetAccess: 'delegated-actor',
        topic: 'privacy.measure.dispatched',
        workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
      },
    ],
    [
      'PrivacyOutcome',
      {
        consumerModuleKey: 'integration.symmy',
        originActionKey: 'privacy.core.dispatch-privacy-measure',
        originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
        producerModuleKey: 'privacy.core',
        subjectResourceType: 'privacy.core.privacy-measure',
        targetAccess: 'delegated-actor',
        topic: 'privacy.measure.dispatched',
        workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
      },
    ],
  ],
  sources: [
    [
      'dispatch|SymmyRetention|symmy-integration|subject|none',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|SymmyRetention|symmy-integration|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|SymmyRetention|symmy-integration|subject|other.key',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|SymmyRetention|symmy-integration|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|symmy-integration|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|symmy-integration|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|subject|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|subject|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyRetention|privacy|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|subject|none',
      'reject:Durable Privacy dispatch requires its exact receipt contract',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'accept',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|subject|other.key',
      'reject:Durable Privacy dispatch requires its exact receipt contract',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|symmy-integration|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|subject|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|subject|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|SymmyReceipt|privacy|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|subject|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|subject|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|symmy-integration|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|subject|none',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|subject|other.key',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyEligibility|privacy|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|subject|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|subject|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|symmy-integration|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|subject|none',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|subject|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|subject|other.key',
      'reject:Durable Privacy dispatch permits only its exact receipt operation',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|tenant|none',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|tenant|privacy.core.requirement.symmy-owner-execution-outcome',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
    [
      'dispatch|PrivacyOutcome|privacy|tenant|other.key',
      'reject:Finite Privacy dispatch requires its exact operation and governance scope',
    ],
  ],
} as const;

it('keeps Symmy registered exactly as it was hard-coded', () => {
  expect(privacyDispatchConsumers['integration.symmy']).toEqual({
    appId: 'symmy-integration',
    executionOperation: 'SymmyRetention',
    moduleKey: 'integration.symmy',
    receiptOperation: 'SymmyReceipt',
    receiptRequirementKey: 'privacy.core.requirement.symmy-owner-execution-outcome',
    workerKey: symmyWorkerKey,
  });
});

it('keeps the Symmy authority policy and its finite operation contracts exactly', () => {
  expect(
    ops.map((operation) => [
      operation,
      Option.getOrNull(privacyDispatchAuthorityPolicy({ operation, workerKey: symmyWorkerKey })),
    ]),
  ).toEqual(frozen.policy);
  // a Symmy-owned operation needs no worker to derive the same authority
  expect(Option.getOrNull(privacyDispatchAuthorityPolicy({ operation: 'SymmyReceipt' }))).toEqual(
    frozen.policy[1]?.[1],
  );
  expect(ops.map((operation) => [operation, privacyDispatchOperationContract(operation)])).toEqual(frozen.contract);
});

it.effect('accepts exactly the recorded Symmy claim combinations', () =>
  Effect.gen(function* frozenClaims() {
    const accepted: string[] = [];
    const workers = [
      [symmyWorkerKey, 'integration.symmy'],
      [symmyWorkerKey, 'other.module'],
      ['other.worker', 'integration.symmy'],
    ] as const;
    for (const operation of ops) {
      for (const audience of ['symmy-integration', 'privacy']) {
        const dispatchMode = claimsFor({ ...base, operation, sourceMode: 'dispatch' }, audience);
        if (Result.isSuccess(yield* Effect.result(decodeSupportedGatewayContextClaims(dispatchMode)))) {
          accepted.push(`dispatch|${operation}|${audience}`);
        }
        for (const [workerKey, workerModuleKey] of workers) {
          const worker = claimsFor(
            { ...base, claimId: 'claim', operation, sourceMode: 'worker', workerKey, workerModuleKey },
            audience,
          );
          if (Result.isSuccess(yield* Effect.result(decodeSupportedGatewayContextClaims(worker)))) {
            accepted.push(`worker|${operation}|${audience}|${workerKey}|${workerModuleKey}`);
          }
        }
      }
    }
    expect(accepted).toEqual(frozen.accepted);
  }),
);

it.effect('keeps every durable-dispatch delegation decision exactly', () =>
  Effect.gen(function* frozenSources() {
    const requirementKeys = [undefined, 'privacy.core.requirement.symmy-owner-execution-outcome', 'other.key'];
    const operations = [
      { _tag: 'SymmyRetention' },
      { _tag: 'SymmyReceipt', attempt: 1 },
      { _tag: 'PrivacyEligibility' },
      { _tag: 'PrivacyOutcome', attempt: 1 },
    ] as const;
    const decisions: (readonly [string, string])[] = [];
    for (const operation of operations) {
      for (const audience of ['symmy-integration', 'privacy']) {
        for (const legalEntityScope of ['subject', 'tenant'] as const) {
          for (const key of requirementKeys) {
            const source = {
              _tag: 'Dispatch',
              compositionRevision,
              dispatchInvocationId,
              legalEntityId,
              tenantId,
            } as const;
            const intent = { _tag: 'PrivacyDispatch', operation, source } as const;
            const result = yield* acquireDelegatedGatewayContext(
              {
                audience,
                legalEntityScope,
                requestCorrelation: 'frozen',
                subject: key === undefined ? intent : { ...intent, operationRequirementKey: key },
              },
              crypto,
            ).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, configuration),
              Effect.provideService(FetchHttpClient.Fetch, fetchOk),
              Effect.result,
            );
            let decision = 'other-failure';
            if (Result.isSuccess(result)) {
              decision = 'accept';
            } else if (Schema.is(GatewayDelegationSourceError)(result.failure)) {
              decision = `reject:${result.failure.reason}`;
            }
            decisions.push([`dispatch|${operation._tag}|${audience}|${legalEntityScope}|${key ?? 'none'}`, decision]);
          }
        }
      }
    }
    expect(decisions).toEqual(frozen.sources);
  }),
);
