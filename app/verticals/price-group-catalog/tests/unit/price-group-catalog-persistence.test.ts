import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ExpectedPriceGroupCurrentEvidenceSchema,
  PriceGroupCompatibilityContractSchema,
  PriceGroupDefinitionRevisionSchema,
} from '../../shared/domain/price-group.ts';
import type { StablePriceGroupRef } from '../../shared/domain/price-group.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupEffectivePeriodConflict,
  PriceGroupExpectedCurrentConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupPersistenceUnavailable,
  PriceGroupRetirementEffectiveTimeConflict,
  PriceGroupSemanticIdentityConflict,
  PriceGroupTenantScopeFailure,
} from '../../shared/domain/price-group-errors.ts';
import { priceGroupCatalogPersistenceFromRoutineInvoker } from '../../src/persistence/price-group-catalog-persistence.ts';

type PriceGroupCatalogRoutineInvoker = Parameters<typeof priceGroupCatalogPersistenceFromRoutineInvoker>[0];

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceGroupId = '22222222-2222-4222-8222-222222222222';
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'price-group-persistence-contract',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};
const priceGroupRef: StablePriceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const definition = {
  acceptedCatalogRevision: 1,
  classificationPurpose: 'Classifies customers eligible for dealer pricing.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
  created: {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    actorPrincipalId: scope.principalId,
    reason: 'Approved initial definition.',
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Dealer pricing classification.',
  displayName: 'Dealer',
  effectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
  semanticContinuity: null,
};
const storedDefinition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)(definition);
const identity = {
  businessCode: 'DEALER',
  created: definition.created,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: definition.effectivePeriod.effectiveFrom,
    retiredAt: null,
    state: 'ACTIVE',
  },
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef,
};
const requiredContract = Schema.decodeUnknownSync(PriceGroupCompatibilityContractSchema)(
  definition.compatibilityContracts[0],
);
const expectedCurrent = Schema.decodeUnknownSync(ExpectedPriceGroupCurrentEvidenceSchema)({
  catalogRevision: 1,
  definitionRevisionId,
  definitionRevisionNumber: 1,
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef,
});
const currentnessCandidates = {
  MULTIPLE_CURRENT_DEFINITIONS: [definitionRevisionId, '66666666-6666-4666-8666-666666666666'],
  UNVERIFIABLE_CURRENTNESS: [definitionRevisionId],
  ZERO_CURRENT_DEFINITIONS: [],
} as const;
const scheduledRetirement = {
  acceptedCatalogRevision: 2,
  currentDefinitionRevisionId: definitionRevisionId,
  currentDefinitionRevisionNumber: 1,
  priceGroupRef,
  retirementEffectiveAt: '2026-11-01T00:00:00.000Z',
  retirementProvenance: definition.created,
  trustedOperationAt: definition.created.trustedAt,
  verifiedAt: '2026-09-23T12:00:01.000Z',
};

it.effect('rejects a cross-tenant reference before invoking PostgreSQL', () =>
  Effect.gen(function* rejectCrossTenantBeforeInvocation() {
    let invocations = 0;
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () => {
        invocations += 1;
        return Effect.succeed([]);
      },
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.readCurrentDefinition(
        { ...priceGroupRef, tenantId: '99999999-9999-4999-8999-999999999999' },
        new Date('2026-10-01T00:00:00.000Z'),
      ),
    );
    expect(Schema.is(PriceGroupTenantScopeFailure)(failure)).toBe(true);
    if (Schema.is(PriceGroupTenantScopeFailure)(failure)) {
      expect(failure.expectedTenantId).toBe(tenantId);
      expect(failure.receivedTenantId).toBe('99999999-9999-4999-8999-999999999999');
    }
    expect(invocations).toBe(0);
  }),
);

for (const reason of [
  'ZERO_CURRENT_DEFINITIONS',
  'MULTIPLE_CURRENT_DEFINITIONS',
  'UNVERIFIABLE_CURRENTNESS',
] as const) {
  it.effect(`maps ${reason} without choosing a technical winner`, () =>
    Effect.gen(function* mapCurrentnessFailure() {
      const candidates = currentnessCandidates[reason];
      const invoker: PriceGroupCatalogRoutineInvoker = {
        invoke: () =>
          Effect.succeed([
            { payload: { _tag: 'currentness_failure', candidateDefinitionRevisionIds: candidates, reason } },
          ]),
      };
      const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
      const failure = yield* Effect.flip(
        persistence.readCurrentDefinition(priceGroupRef, new Date('2026-10-01T00:00:00.000Z')),
      );
      expect(Schema.is(PriceGroupCurrentnessFailure)(failure)).toBe(true);
      if (Schema.is(PriceGroupCurrentnessFailure)(failure)) {
        expect(failure.candidateDefinitionRevisionIds).toEqual(candidates);
        expect(failure.reason).toBe(reason);
      }
    }),
  );
}

it.effect('keeps idempotency reuse distinct from expected-current conflicts', () =>
  Effect.gen(function* mapIdempotencyConflict() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () => Effect.succeed([{ payload: { _tag: 'idempotency_conflict' } }]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.createPriceGroup({
        actingPrincipalId: definition.created.actorPrincipalId,
        actionInvocationId: definition.created.actionInvocationId,
        businessCode: 'DEALER',
        classificationPurpose: definition.classificationPurpose,
        compatibilityContracts: storedDefinition.compatibilityContracts,
        definitionRevisionId,
        description: definition.description,
        displayName: definition.displayName,
        effectiveFrom: new Date(definition.effectivePeriod.effectiveFrom),
        expectedCatalogRevision: 0,
        priceGroupId,
        reason: definition.created.reason,
        trustedEffectiveAt: new Date(definition.created.trustedAt),
      }),
    );
    expect(Schema.is(PriceGroupIdempotencyReuseConflict)(failure)).toBe(true);
    if (Schema.is(PriceGroupIdempotencyReuseConflict)(failure)) {
      expect(failure.actionInvocationId).toBe(definition.created.actionInvocationId);
    }
  }),
);

it.effect('maps duplicate semantic identity to its exact owner conflict', () =>
  Effect.gen(function* mapSemanticIdentityConflict() {
    const requestedMeaningFingerprint = 'b'.repeat(64);
    const existingMeaningFingerprint = requestedMeaningFingerprint;
    const existingPriceGroupId = '66666666-6666-4666-8666-666666666666';
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () =>
        Effect.succeed([
          {
            payload: {
              _tag: 'semantic_identity_conflict',
              existingMeaningFingerprint,
              existingPriceGroupId,
              requestedMeaningFingerprint,
            },
          },
        ]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.createPriceGroup({
        actingPrincipalId: definition.created.actorPrincipalId,
        actionInvocationId: definition.created.actionInvocationId,
        businessCode: 'DISTRIBUTOR',
        classificationPurpose: definition.classificationPurpose,
        compatibilityContracts: storedDefinition.compatibilityContracts,
        definitionRevisionId,
        description: definition.description,
        displayName: definition.displayName,
        effectiveFrom: new Date(definition.effectivePeriod.effectiveFrom),
        expectedCatalogRevision: 0,
        priceGroupId,
        reason: definition.created.reason,
        trustedEffectiveAt: new Date(definition.created.trustedAt),
      }),
    );

    expect(Schema.is(PriceGroupSemanticIdentityConflict)(failure)).toBe(true);
    if (Schema.is(PriceGroupSemanticIdentityConflict)(failure)) {
      expect(failure.existingPriceGroupRef.resourceId).toBe(existingPriceGroupId);
      expect(failure.existingMeaningFingerprint).toBe(existingMeaningFingerprint);
      expect(failure.requestedMeaningFingerprint).toBe(requestedMeaningFingerprint);
    }
  }),
);

it.effect('separates the Create business result from private containment reconciliation state', () =>
  Effect.gen(function* decodeCreateBusinessResult() {
    const projection = {
      mutationId: '77777777-7777-4777-8777-777777777777',
      operation: 'touch_containment',
      staged: true,
    } as const;
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () => Effect.succeed([{ payload: { _tag: 'accepted', definition: storedDefinition, projection } }]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const result = yield* persistence.createPriceGroup({
      actingPrincipalId: definition.created.actorPrincipalId,
      actionInvocationId: definition.created.actionInvocationId,
      businessCode: 'DEALER',
      classificationPurpose: definition.classificationPurpose,
      compatibilityContracts: storedDefinition.compatibilityContracts,
      definitionRevisionId,
      description: definition.description,
      displayName: definition.displayName,
      effectiveFrom: new Date(definition.effectivePeriod.effectiveFrom),
      expectedCatalogRevision: 0,
      priceGroupId,
      reason: definition.created.reason,
      trustedEffectiveAt: new Date(definition.created.trustedAt),
    });

    expect(result.businessResult).toMatchObject({
      acceptance: { definitionRevisionId },
      identity: { businessCode: 'DEALER', meaningFingerprint: definition.meaningFingerprint },
      initialDefinition: { definitionRevisionId },
    });
    expect(result.projection).toEqual(projection);
    expect('outcome' in result.businessResult).toBe(false);
    expect('reconciliation' in result.businessResult).toBe(false);
  }),
);

it.effect('preserves accepted scheduled-retirement evidence on governed definition snapshots', () =>
  Effect.gen(function* decodeScheduledRetirement() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () =>
        Effect.succeed([
          {
            payload: {
              _tag: 'current',
              catalogRevision: 1,
              definition: storedDefinition,
              identity,
              scheduledRetirement,
            },
          },
        ]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const snapshot = yield* persistence.readCurrentDefinition(priceGroupRef, new Date('2026-10-01T00:00:00.000Z'));
    expect(snapshot.scheduledRetirement).toEqual(scheduledRetirement);
  }),
);

it.effect('maps compatibility expected-current mismatch to its explicit typed failure', () =>
  Effect.gen(function* mapExpectedCurrentConflict() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () => Effect.succeed([{ payload: { _tag: 'expected_current_conflict' } }]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.validateCompatibility(
        priceGroupRef,
        requiredContract,
        new Date('2026-10-01T00:00:00.000Z'),
        expectedCurrent,
      ),
    );
    expect(Schema.is(PriceGroupExpectedCurrentConflict)(failure)).toBe(true);
    if (Schema.is(PriceGroupExpectedCurrentConflict)(failure)) {
      expect(failure.priceGroupRef).toEqual(priceGroupRef);
    }
  }),
);

it.effect('maps retroactive definition schedules to the exact effective-period conflict', () =>
  Effect.gen(function* mapEffectivePeriodConflict() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () =>
        Effect.succeed([
          {
            payload: {
              _tag: 'effective_period_conflict',
              effectiveFrom: '2026-09-10T00:00:00.000Z',
              trustedEffectiveAt: '2026-09-20T00:00:00.000Z',
            },
          },
        ]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.createDefinitionRevision({
        actingPrincipalId: definition.created.actorPrincipalId,
        actionInvocationId: '88888888-8888-4888-8888-888888888888',
        classificationPurpose: definition.classificationPurpose,
        compatibilityContracts: storedDefinition.compatibilityContracts,
        description: definition.description,
        displayName: definition.displayName,
        effectiveFrom: new Date('2026-09-10T00:00:00.000Z'),
        expectedCurrent,
        reason: definition.created.reason,
        semanticDecision: {
          comparedDefinitionRevisionId: definitionRevisionId,
          decision: 'SAME_MEANING',
        },
        trustedEffectiveAt: new Date('2026-09-20T00:00:00.000Z'),
      }),
    );
    expect(Schema.is(PriceGroupEffectivePeriodConflict)(failure)).toBe(true);
  }),
);

it.effect('maps backdated retirement times to the exact retirement-time conflict', () =>
  Effect.gen(function* mapRetirementEffectiveTimeConflict() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () =>
        Effect.succeed([
          {
            payload: {
              _tag: 'retirement_effective_time_conflict',
              effectiveAt: '2026-09-30T00:00:00.000Z',
              trustedEffectiveAt: '2026-10-01T00:00:00.000Z',
            },
          },
        ]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.retirePriceGroup({
        actingPrincipalId: definition.created.actorPrincipalId,
        actionInvocationId: '99999999-9999-4999-8999-999999999998',
        effectiveAt: new Date('2026-09-30T00:00:00.000Z'),
        expectedCurrent,
        reason: 'Attempted backdated retirement.',
        trustedEffectiveAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    );
    expect(Schema.is(PriceGroupRetirementEffectiveTimeConflict)(failure)).toBe(true);
  }),
);

it.effect('decodes accepted and replayed mutation outcomes identically', () =>
  Effect.gen(function* decodeMutationOutcomes() {
    for (const tag of ['accepted', 'replayed'] as const) {
      const invoker: PriceGroupCatalogRoutineInvoker = {
        invoke: () => Effect.succeed([{ payload: { _tag: tag, definition: storedDefinition } }]),
      };
      const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
      const result = yield* persistence.createDefinitionRevision({
        actingPrincipalId: definition.created.actorPrincipalId,
        actionInvocationId: '77777777-7777-4777-8777-777777777777',
        classificationPurpose: definition.classificationPurpose,
        compatibilityContracts: storedDefinition.compatibilityContracts,
        definitionRevisionId,
        description: definition.description,
        displayName: definition.displayName,
        effectiveFrom: new Date(definition.effectivePeriod.effectiveFrom),
        expectedCurrent,
        reason: definition.created.reason,
        semanticDecision: {
          comparedDefinitionRevisionId: definitionRevisionId,
          decision: 'SAME_MEANING',
        },
        trustedEffectiveAt: new Date(definition.created.trustedAt),
      });
      expect(result).toEqual(storedDefinition);
    }
  }),
);

it.effect('decodes exact revision payloads and injects no legal-entity input', () =>
  Effect.gen(function* decodeRevisionPayload() {
    let values: readonly unknown[] | undefined;
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: (_routine, routineValues) => {
        values = routineValues;
        return Effect.succeed([{ payload: { _tag: 'found', definition, identity } }]);
      },
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const at = new Date('2026-10-01T00:00:00.000Z');
    const stored = yield* persistence.readDefinitionRevision(priceGroupRef, definitionRevisionId, at);
    expect(stored.definition.definitionRevisionId).toBe(definitionRevisionId);
    expect(stored.identity.businessCode).toBe('DEALER');
    expect(values).toEqual([priceGroupId, definitionRevisionId, at]);
  }),
);

it.effect('maps invalid driver payloads to a stable failure without leaking driver detail', () =>
  Effect.gen(function* mapInvalidPayload() {
    const invoker: PriceGroupCatalogRoutineInvoker = {
      invoke: () => Effect.succeed([{ payload: { driverMessage: 'secret SQL and bind parameters' } }]),
    };
    const persistence = priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope);
    const failure = yield* Effect.flip(
      persistence.readDefinitionRevision(priceGroupRef, definitionRevisionId, new Date('2026-10-01T00:00:00.000Z')),
    );
    expect(Schema.is(PriceGroupPersistenceUnavailable)(failure)).toBe(true);
    if (Schema.is(PriceGroupPersistenceUnavailable)(failure)) {
      expect(failure.reason).toBe('Price Group Catalog persistence is temporarily unavailable');
      expect(failure.retryable).toBe(true);
    }
    expect(JSON.stringify(failure)).not.toContain('secret SQL');
  }),
);
