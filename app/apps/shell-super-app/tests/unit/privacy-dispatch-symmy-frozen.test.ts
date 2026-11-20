/**
 * Frozen Symmy decisions of the Shell Privacy dispatch evidence graph. Every literal was recorded from base 6adcc096f
 * BEFORE the evidence graph became per-consumer; the registry must keep reproducing them exactly.
 */
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyDispatchConsumer } from '@app/shared-contracts';
import { Effect, Option, Result } from 'effect';
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

/** Symmy's registry entry exactly as it was hard-coded in the evidence graph at base. */
const symmy: PrivacyDispatchConsumer = {
  appId: 'symmy-integration',
  executionOperation: 'SymmyRetention',
  moduleKey: 'integration.symmy',
  receiptOperation: 'SymmyReceipt',
  receiptRequirementKey: 'privacy.core.requirement.symmy-owner-execution-outcome',
  workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
};

const uuid = '70000000-0000-4000-8000-000000000001';
const resource = `integration.symmy.job:${uuid}`;
const handoff: PrivacyMeasureHandoff = {
  contentScopeRefs: [`${resource}#integration.symmy.job-intent`],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['evidence:1'],
  idempotencyKey: 'privacy-idempotency-1',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'integration.symmy',
  preconditionRefs: [],
  requestedAt: '2026-11-20T10:00:00.000Z',
  requestedResult: 'erase job intent',
  resourceRefs: [resource],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId: '30000000-0000-4000-8000-000000000001',
};
const eventOf = (event: PrivacyMeasureHandoff) => ({
  handoff: event,
  measureId: 'measure-1',
  tenantId: handoff.tenantId,
});

it('keeps the Symmy handoff admission exactly', () => {
  const variants: readonly (readonly [string, PrivacyMeasureHandoff])[] = [
    ['anonymize', { ...handoff, dispositionDecision: 'ANONYMIZE', kind: 'ANONYMIZE' }],
    ['badContent', { ...handoff, contentScopeRefs: [`${resource}#other`] }],
    [
      'badResource',
      {
        ...handoff,
        contentScopeRefs: ['x#integration.symmy.job-intent'],
        resourceRefs: ['integration.symmy.job:not-hex!'],
      },
    ],
    ['base', handoff],
    ['foreignOwner', { ...handoff, owningCapability: 'communications.core' }],
    ['foreignTenant', { ...handoff, tenantId: '30000000-0000-4000-8000-000000000009' }],
    ['kindMismatch', { ...handoff, dispositionDecision: 'ANONYMIZE' }],
    ['otherMeasure', { ...handoff, measureId: 'measure-2' }],
    ['restrict', { ...handoff, dispositionDecision: 'RESTRICT', kind: 'RESTRICT' }],
    [
      'syncAdmission',
      {
        ...handoff,
        contentScopeRefs: [`integration.symmy.sync-admission:${uuid}#integration.symmy.job-intent`],
        resourceRefs: [`integration.symmy.sync-admission:${uuid}`],
      },
    ],
    ['twoResources', { ...handoff, resourceRefs: [resource, `integration.symmy.job:${uuid.replace('1', '2')}`] }],
  ];
  expect(
    Object.fromEntries(variants.map(([name, variant]) => [name, isSupportedHandoff(symmy, variant, eventOf(variant))])),
  ).toEqual({
    anonymize: true,
    badContent: false,
    badResource: false,
    base: true,
    foreignOwner: false,
    foreignTenant: false,
    kindMismatch: false,
    otherMeasure: false,
    restrict: false,
    syncAdmission: true,
    twoResources: false,
  });
  expect(isSupportedHandoff(symmy, handoff, eventOf({ ...handoff, taskId: 'other' }))).toBe(false);
});

const hashOf = (operation: Parameters<typeof requestHash>[0]) =>
  requestHash(operation, handoff).pipe(Effect.result, Effect.map(Result.getOrElse(() => 'fail')));

it.effect('keeps the Symmy receipt and execution request hashes exactly', () =>
  Effect.gen(function* frozenHashes() {
    expect(yield* hashOf({ _tag: 'SymmyRetention' })).toBe(
      '1f071135907c0eb0b8a9e748e191f8dd1879e550a97be3e63b7507527ca9c52b',
    );
    expect(yield* hashOf({ _tag: 'SymmyReceipt' })).toBe(
      'f3ccbf0de94a9cbcf305b569826b6e067daa05940a47efa3acd29bd847432afd',
    );
    expect(yield* hashOf({ _tag: 'SymmyReceipt', attempt: 2 })).toBe(
      'f37648c929a99d6cf79f210cf8f9880543d77e71b3d424e59438d40b7b52d5e2',
    );
    expect(yield* hashOf({ _tag: 'PrivacyEligibility' })).toBe(
      '1f071135907c0eb0b8a9e748e191f8dd1879e550a97be3e63b7507527ca9c52b',
    );
    expect(yield* hashOf({ _tag: 'PrivacyOutcome', attempt: 3 })).toBe(
      'a5fb78a2bccd6cf925788a78f004ad4e206049b2688ef50e5a5929ae10171c5f',
    );
  }),
);

it('keeps which operations a Symmy worker may carry and which one the durable read is exactly', () => {
  const operations = ['SymmyRetention', 'SymmyReceipt', 'PrivacyEligibility', 'PrivacyOutcome'] as const;
  expect(
    Object.fromEntries(operations.map((operation) => [operation, workerOperationAllows(symmy, operation)])),
  ).toEqual({ PrivacyEligibility: false, PrivacyOutcome: true, SymmyReceipt: true, SymmyRetention: true });
  expect(
    Object.fromEntries(operations.map((operation) => [operation, receiptOperationAllows(symmy, operation)])),
  ).toEqual({ PrivacyEligibility: false, PrivacyOutcome: false, SymmyReceipt: true, SymmyRetention: false });
});

it('keeps exactly the Symmy continuations: eligibility after retention and a receipt after its outcome', () => {
  const previousOperations = ['SymmyRetention', 'SymmyReceipt', 'PrivacyEligibility', 'PrivacyOutcome'] as const;
  const nextOperations = [
    { _tag: 'SymmyRetention' },
    { _tag: 'SymmyReceipt' },
    { _tag: 'SymmyReceipt', attempt: 2 },
    { _tag: 'PrivacyEligibility' },
    { _tag: 'PrivacyOutcome', attempt: 3 },
  ] as const;
  const continued: unknown[] = [];
  for (const previous of previousOperations) {
    for (const next of nextOperations) {
      const original = Option.getOrNull(originalOperationFor(symmy, previous, next));
      if (original !== null) {
        continued.push([previous, next, original]);
      }
    }
  }
  expect(continued).toEqual([
    ['SymmyRetention', { _tag: 'PrivacyEligibility' }, { _tag: 'SymmyRetention' }],
    ['PrivacyOutcome', { _tag: 'SymmyReceipt', attempt: 2 }, { _tag: 'PrivacyOutcome', attempt: 2 }],
  ]);
});

it('keeps the Symmy worker catalog check exactly', () => {
  const subscription = {
    consumerModuleKey: 'integration.symmy',
    entrypointKey: 'integration.symmy.symmy-job-privacy-dispatch',
    producerModuleKey: 'privacy.core',
    topic: 'privacy.measure.dispatched',
    workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
  };
  const facts = {
    appId: 'symmy-integration',
    moduleId: 'integration.symmy',
    originatorActions: ['privacy.core.dispatch-privacy-measure'],
    subscriptions: [subscription],
  };
  const holds = (override: Partial<typeof facts> = {}) => workerCatalogHolds({ ...facts, ...override }, symmy);
  expect({
    noOriginator: holds({ originatorActions: [] }),
    ok: holds(),
    wrongApp: holds({ appId: 'other' }),
    wrongEntry: holds({ subscriptions: [{ ...subscription, entrypointKey: 'x' }] }),
    wrongKey: holds({ subscriptions: [{ ...subscription, workerKey: 'x' }] }),
    wrongModule: holds({ moduleId: 'other' }),
    wrongTopic: holds({ subscriptions: [{ ...subscription, topic: 'x' }] }),
  }).toEqual({
    noOriginator: false,
    ok: true,
    wrongApp: false,
    wrongEntry: false,
    wrongKey: false,
    wrongModule: false,
    wrongTopic: false,
  });
});

it('keeps the Symmy conditional-call check exactly', () => {
  const target = {
    access: 'read',
    appId: 'symmy-integration',
    declarationKey: 'integration.symmy.privacy-measure.read-receipt',
    entrypointKey: 'integration.symmy.api.symmy-job-privacy-execution',
    legalEntityScope: 'optional',
    moduleId: 'integration.symmy',
    schemaVersion: '1',
  } as const;
  const providerEntrypoint: string = target.entrypointKey;
  const outcome = 'privacy.core.record-owner-execution-outcome';
  const declaration = {
    entrypointKey: outcome,
    key: 'k',
    provider: { entrypointKey: providerEntrypoint, moduleId: target.moduleId, schemaVersion: '1' },
  };
  const privacy = { declarations: [declaration], moduleId: 'privacy.core' };
  const allows = (source: typeof privacy, consumerKey: string, key?: string) =>
    conditionalCallAllows(source, consumerKey, 'integration.symmy', target, key);
  const symmyModule = { declarations: [], moduleId: 'integration.symmy' };
  expect({
    crossDuplicate: allows({ ...privacy, declarations: [declaration, declaration] }, outcome, 'k'),
    crossNoKey: allows(privacy, outcome),
    crossOk: allows(privacy, outcome, 'k'),
    crossWrongConsumer: allows(privacy, 'other.entry', 'k'),
    crossWrongKey: allows(privacy, outcome, 'other'),
    crossWrongProvider: allows(
      { ...privacy, declarations: [{ ...declaration, provider: { ...declaration.provider, entrypointKey: 'z' } }] },
      outcome,
      'k',
    ),
    sameModuleKey: allows(symmyModule, 'x', 'k'),
    sameModuleNoKey: allows(symmyModule, 'x'),
  }).toEqual({
    crossDuplicate: false,
    crossNoKey: false,
    crossOk: true,
    crossWrongConsumer: false,
    crossWrongKey: false,
    crossWrongProvider: false,
    sameModuleKey: false,
    sameModuleNoKey: true,
  });
});
