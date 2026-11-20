import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  OwnerExecutionReceiptRequestSchema,
  PrivacyMeasureHandoffSchema,
} from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { privacyDispatchConsumers, privacyDispatchOperationContract } from '@app/shared-contracts';
import type { PrivacyDispatchConsumer } from '@app/shared-contracts';
import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  conditionalCallAllows,
  isSupportedHandoff,
  originalOperationFor,
  receiptOperationAllows,
  requestHash,
  workerCatalogHolds,
  workerOperationAllows,
} from '../../api/auth/gateway-privacy-dispatch-evidence.ts';

const symmy = privacyDispatchConsumers['integration.symmy'];
const communications = privacyDispatchConsumers['communications.core'];
if (symmy === undefined || communications === undefined) {
  throw new Error('Both approved Privacy dispatch consumers are required by this contract test');
}

const tenantId = '30000000-0000-4000-8000-000000000001';
const uuid = '70000000-0000-4000-8000-000000000001';
const baseHandoff = {
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['evidence:1'],
  idempotencyKey: 'privacy-idempotency-1',
  kind: 'DELETE',
  measureId: 'measure-1',
  preconditionRefs: [],
  requestedAt: '2026-11-20T10:00:00.000Z',
  requestedResult: 'erase message metadata',
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId,
} as const;
const symmyHandoff: PrivacyMeasureHandoff = {
  ...baseHandoff,
  contentScopeRefs: [`integration.symmy.job:${uuid}#integration.symmy.job-intent`],
  owningCapability: 'integration.symmy',
  resourceRefs: [`integration.symmy.job:${uuid}`],
};
const communicationsHandoff: PrivacyMeasureHandoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  ...baseHandoff,
  contentScopeRefs: ['communications.core.history'],
  ownerScope: {
    controllerRef: 'controller-1',
    requestedScopePartRefs: ['communications.core.history'],
    requestedScopeRef: 'scope-1',
    trustedLookups: [
      {
        _tag: 'SUBJECT_REFERENCE',
        lookupRef: 'lookup-1',
        moduleId: 'party.registry',
        resourceId: 'party-1',
        resourceType: 'party',
      },
    ],
  },
  owningCapability: 'communications.core',
  resourceRefs: ['communications.core.intent:intent-1'],
});
const eventOf = (handoff: PrivacyMeasureHandoff, measureId = 'measure-1') => ({ handoff, measureId, tenantId });
const supported = (consumer: PrivacyDispatchConsumer, handoff: PrivacyMeasureHandoff, event = eventOf(handoff)) =>
  isSupportedHandoff(consumer, handoff, event);

it('admits a handoff only for the consumer it is addressed to', () => {
  expect(supported(communications, communicationsHandoff)).toBe(true);
  expect(supported(symmy, symmyHandoff)).toBe(true);
  // an owner's handoff is never another owner's evidence, in either direction
  expect(supported(communications, symmyHandoff)).toBe(false);
  expect(supported(symmy, communicationsHandoff)).toBe(false);
  // the shared requirements hold for Communications too: tenant, measure and the immutable dispatched event
  expect(
    supported(communications, { ...communicationsHandoff, tenantId: '30000000-0000-4000-8000-000000000009' }),
  ).toBe(false);
  expect(supported(communications, communicationsHandoff, eventOf(communicationsHandoff, 'measure-2'))).toBe(false);
  expect(
    supported(communications, communicationsHandoff, eventOf({ ...communicationsHandoff, taskId: 'other-task' })),
  ).toBe(false);
  // an invalid measure is not evidence even for the consumer it names, and neither is one without its exact owner scope
  expect(supported(communications, { ...communicationsHandoff, resourceRefs: [] })).toBe(false);
  const { ownerScope: _scope, ...unscoped } = communicationsHandoff;
  expect(supported(communications, unscoped)).toBe(false);
  // Communications targets only its own opaque content references
  for (const resourceRefs of [
    ['party.registry|party|le|x'],
    ['communications.core.intent:'],
    ['other:communications.core.intent:1'],
  ]) {
    expect(supported(communications, { ...communicationsHandoff, resourceRefs })).toBe(false);
  }
});

it('lets a Communications worker carry only Communications operations and never Symmy execution', () => {
  expect(workerOperationAllows(communications, 'CommunicationsReceipt')).toBe(true);
  expect(workerOperationAllows(communications, 'PrivacyOutcome')).toBe(true);
  expect(workerOperationAllows(communications, 'SymmyRetention')).toBe(false);
  expect(workerOperationAllows(communications, 'SymmyReceipt')).toBe(false);
  expect(workerOperationAllows(communications, 'PrivacyEligibility')).toBe(false);
  expect(workerOperationAllows(symmy, 'CommunicationsReceipt')).toBe(false);
  expect(workerOperationAllows(symmy, 'SymmyRetention')).toBe(true);
  expect(receiptOperationAllows(communications, 'CommunicationsReceipt')).toBe(true);
  expect(receiptOperationAllows(communications, 'SymmyReceipt')).toBe(false);
  expect(receiptOperationAllows(symmy, 'CommunicationsReceipt')).toBe(false);
  expect(receiptOperationAllows(symmy, 'SymmyReceipt')).toBe(true);
});

it('continues a reported outcome into its own consumer receipt and nothing else', () => {
  expect(originalOperationFor(communications, 'PrivacyOutcome', { _tag: 'CommunicationsReceipt', attempt: 2 })).toEqual(
    Option.some({ _tag: 'PrivacyOutcome', attempt: 2 }),
  );
  // the receipt needs the attempt the outcome was reported for
  expect(Option.isNone(originalOperationFor(communications, 'PrivacyOutcome', { _tag: 'CommunicationsReceipt' }))).toBe(
    true,
  );
  // a Communications outcome cannot reach Symmy's receipt, and a Symmy outcome cannot reach Communications'
  expect(
    Option.isNone(originalOperationFor(communications, 'PrivacyOutcome', { _tag: 'SymmyReceipt', attempt: 2 })),
  ).toBe(true);
  expect(
    Option.isNone(originalOperationFor(symmy, 'PrivacyOutcome', { _tag: 'CommunicationsReceipt', attempt: 2 })),
  ).toBe(true);
  // only an outcome continues into a receipt
  expect(
    Option.isNone(
      originalOperationFor(communications, 'CommunicationsReceipt', { _tag: 'CommunicationsReceipt', attempt: 2 }),
    ),
  ).toBe(true);
  // Communications executes nothing, so no eligibility continuation can follow any of its operations
  for (const previous of ['SymmyRetention', 'PrivacyOutcome', 'CommunicationsReceipt'] as const) {
    expect(Option.isNone(originalOperationFor(communications, previous, { _tag: 'PrivacyEligibility' }))).toBe(true);
  }
});

it.effect('binds the Communications receipt request hash to the exact idempotency identity and attempt', () =>
  Effect.gen(function* receiptHash() {
    const withoutAttempt = yield* requestHash({ _tag: 'CommunicationsReceipt' }, communicationsHandoff);
    const withAttempt = yield* requestHash({ _tag: 'CommunicationsReceipt', attempt: 2 }, communicationsHandoff);
    expect(withoutAttempt).toBe(computeCanonicalValueHash({ handoff: communicationsHandoff }));
    expect(withAttempt).toBe(computeCanonicalValueHash({ attempt: 2, handoff: communicationsHandoff }));
    expect(withAttempt).not.toBe(withoutAttempt);
    const other = yield* requestHash(
      { _tag: 'CommunicationsReceipt', attempt: 2 },
      { ...communicationsHandoff, idempotencyKey: 'privacy-idempotency-2' },
    );
    expect(other).not.toBe(withAttempt);
    // the request is bound to the exact handoff, scope included: another owner scope is another request
    const rescoped = yield* requestHash(
      { _tag: 'CommunicationsReceipt', attempt: 2 },
      Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        ...communicationsHandoff,
        ownerScope: { ...communicationsHandoff.ownerScope, controllerRef: 'another-controller' },
      }),
    );
    expect(rescoped).not.toBe(withAttempt);
    expect(
      Result.isFailure(
        yield* Effect.result(requestHash({ _tag: 'CommunicationsReceipt', attempt: 0 }, communicationsHandoff)),
      ),
    ).toBe(true);
  }),
);

it.effect(
  'hashes a real owner scope exactly as it arrives on the wire, blocker assessment and every lookup kind included',
  () =>
    Effect.gen(function* wireEquality() {
      const withScope = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        ...communicationsHandoff,
        ownerScope: {
          blockerAssessment: {
            assessedByRef: 'privacy-assessment-1',
            blockers: [
              { blockerRef: 'hold-1', contentRefs: ['communications.core.intent:intent-1'], kind: 'LEGAL_HOLD' },
            ],
          },
          controllerRef: 'controller-1',
          requestedScopePartRefs: ['communications.core.history', 'communications.core.requests'],
          requestedScopeRef: 'scope-1',
          trustedLookups: [
            {
              _tag: 'SUBJECT_REFERENCE',
              lookupRef: 'lookup-1',
              moduleId: 'party.registry',
              resourceId: 'p-1',
              resourceType: 'party',
            },
            {
              _tag: 'CONTACT_REFERENCE',
              lookupRef: 'lookup-2',
              moduleId: 'party.registry',
              resourceId: 'c-1',
              resourceType: 'contact',
            },
            { _tag: 'ACTOR_PRINCIPAL', lookupRef: 'lookup-3', principalId: '80000000-0000-4000-8000-000000000001' },
          ],
        },
      });
      for (const attempt of [undefined, 2]) {
        // what the owner receives is the JSON the Shell attests: decoding it must give the very request that was hashed
        const request = attempt === undefined ? { handoff: withScope } : { attempt, handoff: withScope };
        const text = Schema.encodeSync(Schema.fromJsonString(OwnerExecutionReceiptRequestSchema))(request);
        const wire = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(text);
        const received = Schema.decodeUnknownSync(Schema.fromJsonString(OwnerExecutionReceiptRequestSchema))(text);
        const attested = yield* requestHash(
          attempt === undefined ? { _tag: 'CommunicationsReceipt' } : { _tag: 'CommunicationsReceipt', attempt },
          withScope,
        );
        expect(computeCanonicalValueHash(received)).toBe(attested);
        expect(computeCanonicalValueHash(wire)).toBe(attested);
      }
    }),
);

const factsOf = (
  consumer: PrivacyDispatchConsumer,
  subscription: Partial<PrivacyDispatchConsumerSubscription> = {},
) => ({
  appId: consumer.appId,
  moduleId: consumer.moduleKey,
  originatorActions: ['privacy.core.dispatch-privacy-measure'],
  subscriptions: [
    {
      consumerModuleKey: consumer.moduleKey,
      entrypointKey: consumer.workerKey,
      producerModuleKey: 'privacy.core',
      topic: 'privacy.measure.dispatched',
      workerKey: consumer.workerKey,
      ...subscription,
    },
  ],
});
interface PrivacyDispatchConsumerSubscription {
  readonly consumerModuleKey: string;
  readonly entrypointKey: string;
  readonly producerModuleKey: string;
  readonly topic: string;
  readonly workerKey: string;
}

it('recognizes a consumer by its own deployed worker subscription only', () => {
  expect(workerCatalogHolds(factsOf(communications), communications)).toBe(true);
  expect(workerCatalogHolds(factsOf(symmy), symmy)).toBe(true);
  // neither consumer's deployment is the other's worker
  expect(workerCatalogHolds(factsOf(communications), symmy)).toBe(false);
  expect(workerCatalogHolds(factsOf(symmy), communications)).toBe(false);
  for (const subscription of [
    { topic: 'communications.core.message-intent-prepared.v1' },
    { producerModuleKey: 'communications.core' },
    { workerKey: 'communications.core.prepare-message-handoff' },
    { entrypointKey: 'communications.core.prepare-message-handoff' },
  ]) {
    expect(workerCatalogHolds(factsOf(communications, subscription), communications)).toBe(false);
  }
  expect(workerCatalogHolds({ ...factsOf(communications), originatorActions: [] }, communications)).toBe(false);
});

it('requires the Communications receipt requirement to name exactly the published Communications Read', () => {
  const target = privacyDispatchOperationContract('CommunicationsReceipt');
  const outcome = privacyDispatchOperationContract('PrivacyOutcome').entrypointKey;
  const declaration = (provider: Partial<{ entrypointKey: string; moduleId: string }> = {}) => ({
    entrypointKey: outcome,
    key: communications.receiptRequirementKey,
    provider: {
      entrypointKey: target.entrypointKey,
      moduleId: target.moduleId,
      schemaVersion: target.schemaVersion,
      ...provider,
    },
  });
  const privacy = { declarations: [declaration()], moduleId: 'privacy.core' };
  const key = communications.receiptRequirementKey;
  const allows = (source: typeof privacy, consumerKey: string, requirementKey?: string) =>
    conditionalCallAllows(source, consumerKey, 'communications.core', target, requirementKey);
  expect(allows(privacy, outcome, key)).toBe(true);
  expect(allows(privacy, outcome)).toBe(false);
  expect(allows(privacy, outcome, symmy.receiptRequirementKey)).toBe(false);
  expect(allows(privacy, 'privacy.core.dispatch-privacy-measure', key)).toBe(false);
  // a requirement that points at Symmy's receipt Read is not a Communications receipt contract
  expect(
    allows(
      {
        ...privacy,
        declarations: [
          declaration({
            entrypointKey: 'integration.symmy.api.symmy-job-privacy-execution',
            moduleId: 'integration.symmy',
          }),
        ],
      },
      outcome,
      key,
    ),
  ).toBe(false);
});
