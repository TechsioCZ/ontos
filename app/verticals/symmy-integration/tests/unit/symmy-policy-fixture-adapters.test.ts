import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { symmyAssortmentRuleOperation } from '../../shared/domain/symmy-assortment-rule-mapping.ts';
import { SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyEffectAdapterInput } from '../../src/services/symmy-effect-adapters.service.ts';
import {
  SymmyPolicyFixtureAdapters,
  SymmyPolicyFixtureAdaptersLive,
} from '../../src/services/symmy-policy-fixture-adapters.ts';

const tenantId = 'c407aada-ff28-40b6-a1fb-af5e711e4ebc';
const principalId = '843147ab-11ef-49da-9ef3-dc0a54f0cbd1';
const actionInvocationId = '11111111-1111-4111-8111-111111111111';
const requestHash = 'a'.repeat(64);
const effect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  effectKey: 'assortment-rule',
  itemId: '3b7625e5-509f-45e5-8175-049cb8614765',
  ref: {
    effectId: 'cd55d31b-29fa-4344-af9f-7321906bfa0a',
    mappingVersion: 'INTERNAL_C14_ASSORTMENT_RULE_V1',
    occurrence: {
      occurrenceId: 'fixture',
      record: {
        entityKind: 'ASSORTMENT_RULE',
        issuerId: 'fixture-issuer',
        route: { integrationRouteId: 'fixture-route', tenantId },
        sourceNamespace: 'fixture',
        sourceRecordId: 'explicit-rule',
      },
    },
    operation: symmyAssortmentRuleOperation,
    routeRevision: 'v1',
  },
});

const originalAttempt: SymmyEffectAdapterInput = {
  admission: {
    actionInvocationId,
    compositionRevision: 'v1',
    sourceActionKey: 'integration.symmy.admit-symmy-sync',
    tenantId,
  },
  canExecuteNewEffects: true,
  dependencies: [],
  effect,
  originalExecutorPrincipalId: principalId,
  readOriginalActionInvocation: () => Effect.die('There is no hash to look up'),
  recordInvocationId: () => Effect.die('Recovery inspection cannot write'),
  recordOwnerReceipt: () => Effect.die('Recovery inspection cannot write'),
  recordOwnerRequest: () => Effect.die('Recovery inspection cannot write'),
  recordResolvedEffect: () => Effect.die('Recovery inspection cannot write'),
};

it.effect('allows the exact original key to finish an interrupted pin or an open Core invocation', () =>
  Effect.gen(function* resumeOriginalFixtureEffect() {
    const { adapters } = yield* SymmyPolicyFixtureAdapters;
    const [assortment] = adapters;
    expect(assortment.operation).toEqual(symmyAssortmentRuleOperation);
    expect(yield* assortment.recover(originalAttempt)).toEqual({ status: 'retry_original_key' });
    expect(yield* assortment.recover({ ...originalAttempt, originalRequestHash: requestHash })).toEqual({
      status: 'unavailable',
    });
    for (const [status, expected] of [
      ['received', 'retry_original_key'],
      ['running', 'retry_original_key'],
      ['indeterminate', 'unavailable'],
      ['rejected', 'unavailable'],
    ]) {
      const outcome = yield* assortment.recover({
        ...originalAttempt,
        originalAuthContextRef: 'fixture-owner-attempt',
        originalRequestHash: requestHash,
        readOriginalActionInvocation: (query) =>
          Effect.sync(() => {
            expect(query).toEqual({
              actionKey: symmyAssortmentRuleOperation.entrypointKey,
              idempotencyKey: effect.ref.effectId,
              originalPrincipalId: principalId,
              requestHash,
            });
            return Option.some({ actionInvocationId, status });
          }),
      });
      expect(outcome).toEqual({ status: expected });
    }
    expect(
      yield* assortment.recover({
        ...originalAttempt,
        originalAuthContextRef: 'fixture-owner-attempt',
        originalInvocationId: actionInvocationId,
        originalRequestHash: requestHash,
        readOriginalActionInvocation: () => Effect.succeed(Option.none()),
      }),
    ).toEqual({ status: 'unavailable' });
    expect(yield* assortment.recover({ ...originalAttempt, canExecuteNewEffects: false })).toEqual({
      status: 'unavailable',
    });
  }).pipe(Effect.provide(SymmyPolicyFixtureAdaptersLive), Effect.provide(NodeCrypto.layer)),
);

it.effect('settles the exact committed policy effect after new execution authority is lost', () =>
  Effect.gen(function* settleCommittedPolicyFixture() {
    const { adapters } = yield* SymmyPolicyFixtureAdapters;
    for (const adapter of adapters) {
      const recorded = yield* Ref.make(Option.none<string>());
      const original = {
        ...originalAttempt,
        canExecuteNewEffects: false,
        effect: { ...effect, ref: { ...effect.ref, operation: adapter.operation } },
        originalAuthContextRef: 'fixture-owner-attempt',
        originalRequestHash: requestHash,
        readOriginalActionInvocation: () => Effect.succeed(Option.some({ actionInvocationId, status: 'succeeded' })),
        recordInvocationId: (invocationId: string) => Ref.set(recorded, Option.some(invocationId)),
      };
      expect(yield* adapter.recover(original)).toEqual({
        outcome: {
          effectId: effect.ref.effectId,
          owner: adapter.operation.moduleId,
          status: 'accepted_change',
        },
        status: 'settled',
      });
      expect(yield* Ref.get(recorded)).toEqual(Option.some(actionInvocationId));
    }
  }).pipe(Effect.provide(SymmyPolicyFixtureAdaptersLive), Effect.provide(NodeCrypto.layer)),
);
