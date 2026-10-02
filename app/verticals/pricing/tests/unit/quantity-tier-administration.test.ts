import {
  QuantityTierIdentityKeySchema,
  QuantityTierScheduleSnapshotSchema,
  ScheduledQuantityTierRevisionSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ManageQuantityTierAcknowledgementRequired,
  ManageQuantityTierPayloadSchema,
  ManageQuantityTierRejected,
  applyQuantityTierManagement,
  manageQuantityTierAction,
} from '../../src/actions/manage-quantity-tier.action.ts';
import type { ManageQuantityTierActionServices } from '../../src/actions/manage-quantity-tier.action.ts';
import { makeQuantityTierAdministration } from '../../src/services/quantity-tier-administration.service.ts';
import { QuantityTierPersistenceUnavailable } from '../../src/services/quantity-tier-persistence.service.ts';
import type {
  DefineQuantityTierPersistenceCommand,
  QuantityTierPersistence,
  ReviseQuantityTierPersistenceCommand,
} from '../../src/services/quantity-tier-persistence.service.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const identityKey = Schema.decodeSync(QuantityTierIdentityKeySchema)({
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 7,
      targetRef: {
        moduleId: 'commerce.catalog',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
      unitRuleRevision: 9,
    },
    priceUnitBasis: {
      quantity: '1',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
    },
  },
  thresholdQuantity: '10',
});
const currentPeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-09-28T00:00:00.000Z',
} as const;
const futurePeriod = { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null } as const;
const valueChangeEffectiveFrom = '2026-09-27T12:00:00.000Z' as const;
const current = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
  definition: {
    identityKey,
    revision: {
      effectiveFrom: currentPeriod.effectiveFrom,
      monetaryBoundary: 'PRE_TAX',
      resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
      revision: 1,
      revisionId: '77777777-7777-4777-8777-777777777777',
    },
  },
  effectivePeriod: currentPeriod,
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
const future = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
  definition: {
    identityKey,
    revision: {
      effectiveFrom: futurePeriod.effectiveFrom,
      monetaryBoundary: 'PRE_TAX',
      resultingUnitPrice: { amount: '80', currencyCode: 'CZK' },
      revision: 2,
      revisionId: '88888888-8888-4888-8888-888888888888',
    },
  },
  effectivePeriod: futurePeriod,
  lineage: {
    correctedRevisionId: null,
    kind: 'SCHEDULED',
    previousRevisionId: current.definition.revision.revisionId,
  },
});
const revisedCurrent = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
  definition: {
    identityKey,
    revision: {
      effectiveFrom: valueChangeEffectiveFrom,
      monetaryBoundary: 'PRE_TAX',
      resultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
      revision: 3,
      revisionId: '99999999-9999-4999-8999-999999999999',
    },
  },
  effectivePeriod: { effectiveFrom: valueChangeEffectiveFrom, effectiveTo: currentPeriod.effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind: 'VALUE_ONLY_CURRENT',
    previousRevisionId: current.definition.revision.revisionId,
  },
});
const preservedCurrentPredecessor = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
  ...current,
  effectivePeriod: { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: valueChangeEffectiveFrom },
});
const revisedSchedule = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
  current: revisedCurrent,
  future: [future],
  identityKey,
  observedAt: '2026-09-27T12:00:00.000Z',
  revisions: [preservedCurrentPredecessor, revisedCurrent, future],
  scheduleRevision: 3,
});
const predecessorDroppingSchedule = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
  ...revisedSchedule,
  revisions: [revisedCurrent, future],
});
const trusted = {
  actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  reason: 'Quantity Tier administration test',
  requestCorrelationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T12:00:00.000Z')),
};
const defineCommand: DefineQuantityTierPersistenceCommand = {
  ...trusted,
  effectivePeriod: currentPeriod,
  expectedState: { state: 'ABSENT' },
  identityKey,
  resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
};
const valueOnlyCommand: ReviseQuantityTierPersistenceCommand = {
  ...trusted,
  effectiveFrom: valueChangeEffectiveFrom,
  expectedCurrent: {
    effectivePeriod: currentPeriod,
    identityKey,
    revision: current.definition.revision.revision,
    revisionId: current.definition.revision.revisionId,
    scheduleRevision: 2,
  },
  identityKey,
  intent: 'VALUE_ONLY_CURRENT',
  resultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
};
const acknowledgement = {
  actingPrincipalId: trusted.actingPrincipalId,
  fingerprint: 'a'.repeat(64),
  identityKey,
  intendedEffectivePeriod: { effectiveFrom: valueChangeEffectiveFrom, effectiveTo: currentPeriod.effectiveTo },
  intendedResultingUnitPrice: valueOnlyCommand.resultingUnitPrice,
  intent: 'VALUE_ONLY_CURRENT' as const,
  presentedFuture: [future],
  scheduleRevision: valueOnlyCommand.expectedCurrent.scheduleRevision,
  targetEffectivePeriod: currentPeriod,
  targetRevisionId: current.definition.revision.revisionId,
};

const persistence = (overrides: Partial<QuantityTierPersistence>): QuantityTierPersistence => ({
  define: () => Effect.die('unexpected define'),
  readCurrent: () => Effect.die('unexpected readCurrent'),
  readCurrentSet: () => Effect.die('unexpected readCurrentSet'),
  readSchedule: () => Effect.die('unexpected readSchedule'),
  revise: () => Effect.die('unexpected revise'),
  verifySetGeneration: () => Effect.die('unexpected verifySetGeneration'),
  ...overrides,
});

describe('Quantity Tier administration service', () => {
  it.effect('accepts only a definition bound to the exact Price, threshold, basis, value, and effective start', () => {
    const service = makeQuantityTierAdministration(
      persistence({
        define: () =>
          Effect.succeed({
            definition: current.definition,
            outcome: 'QUANTITY_TIER_CREATED',
          }),
      }),
    );
    return Effect.gen(function* exactDefinition() {
      const result = yield* service.define(defineCommand);
      expect(result.outcome).toBe('QUANTITY_TIER_CREATED');
    });
  });

  it.effect('fails closed when persistence returns a success for a different exact Tier', () => {
    const service = makeQuantityTierAdministration(
      persistence({
        define: () =>
          Effect.succeed({
            definition: {
              ...current.definition,
              identityKey: { ...identityKey, thresholdQuantity: '20' },
            },
            outcome: 'QUANTITY_TIER_CREATED',
          }),
      }),
    );
    return service.define(defineCommand).pipe(
      Effect.flip,
      Effect.map((failure) => expect(failure).toBeInstanceOf(QuantityTierPersistenceUnavailable)),
    );
  });

  it.effect('preserves a finite Current end, its gap, and every existing future Revision on value-only edit', () => {
    const service = makeQuantityTierAdministration(
      persistence({
        revise: () =>
          Effect.succeed({
            outcome: 'QUANTITY_TIER_REVISED',
            schedule: revisedSchedule,
          }),
      }),
    );
    return Effect.gen(function* preservedSchedule() {
      const result = yield* service.revise({ ...valueOnlyCommand, acknowledgement });
      if (result.outcome !== 'QUANTITY_TIER_REVISED') {
        throw new Error('Expected revised Quantity Tier schedule');
      }
      expect(result.schedule.current?.effectivePeriod).toEqual({
        effectiveFrom: valueChangeEffectiveFrom,
        effectiveTo: currentPeriod.effectiveTo,
      });
      expect(result.schedule.future).toEqual([future]);
      expect(result.schedule.revisions).toEqual([preservedCurrentPredecessor, revisedCurrent, future]);
      const unacknowledged = yield* Effect.flip(service.revise(valueOnlyCommand));
      expect(unacknowledged).toBeInstanceOf(QuantityTierPersistenceUnavailable);
    });
  });

  it.effect('fails closed when a value-only successor drops the targeted immutable predecessor interval', () => {
    const service = makeQuantityTierAdministration(
      persistence({
        revise: () =>
          Effect.succeed({
            outcome: 'QUANTITY_TIER_REVISED',
            schedule: predecessorDroppingSchedule,
          }),
      }),
    );
    return service.revise({ ...valueOnlyCommand, acknowledgement }).pipe(
      Effect.flip,
      Effect.map((failure) => expect(failure).toBeInstanceOf(QuantityTierPersistenceUnavailable)),
    );
  });

  it.effect('fails closed when a success is paired with an acknowledgement for another actor or changed future', () => {
    const service = makeQuantityTierAdministration(
      persistence({
        revise: () => Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: revisedSchedule }),
      }),
    );
    const changedFuture = {
      ...future,
      definition: {
        ...future.definition,
        revision: {
          ...future.definition.revision,
          resultingUnitPrice: { amount: '79', currencyCode: 'CZK' as const },
        },
      },
    };
    return Effect.gen(function* rejectsForgedAcknowledgement() {
      const wrongActor = yield* Effect.flip(
        service.revise({
          ...valueOnlyCommand,
          acknowledgement: { ...acknowledgement, actingPrincipalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        }),
      );
      expect(wrongActor).toBeInstanceOf(QuantityTierPersistenceUnavailable);

      const changedSchedule = yield* Effect.flip(
        service.revise({
          ...valueOnlyCommand,
          acknowledgement: { ...acknowledgement, presentedFuture: [changedFuture] },
        }),
      );
      expect(changedSchedule).toBeInstanceOf(QuantityTierPersistenceUnavailable);
    });
  });

  it.effect('creates a future Revision without filling the gap or changing the existing Current interval', () => {
    const scheduled = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
      definition: {
        identityKey,
        revision: {
          effectiveFrom: futurePeriod.effectiveFrom,
          monetaryBoundary: 'PRE_TAX',
          resultingUnitPrice: { amount: '80', currencyCode: 'CZK' },
          revision: 2,
          revisionId: '88888888-8888-4888-8888-888888888888',
        },
      },
      effectivePeriod: futurePeriod,
      lineage: {
        correctedRevisionId: null,
        kind: 'SCHEDULED',
        previousRevisionId: current.definition.revision.revisionId,
      },
    });
    const schedule = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
      current,
      future: [scheduled],
      identityKey,
      observedAt: '2026-09-27T12:00:00.000Z',
      revisions: [current, scheduled],
      scheduleRevision: 2,
    });
    const command: ReviseQuantityTierPersistenceCommand = {
      ...trusted,
      effectivePeriod: futurePeriod,
      expectedScheduleRevision: 1,
      identityKey,
      intent: 'SCHEDULE_REVISION',
      resultingUnitPrice: { amount: '80', currencyCode: 'CZK' },
    };
    const service = makeQuantityTierAdministration(
      persistence({
        revise: () => Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule }),
      }),
    );
    return Effect.gen(function* scheduledRevision() {
      const result = yield* service.revise(command);
      if (result.outcome !== 'QUANTITY_TIER_REVISED') {
        throw new Error('Expected revised Quantity Tier schedule');
      }
      expect(result.schedule.current?.effectivePeriod).toEqual(currentPeriod);
      expect(result.schedule.future).toEqual([scheduled]);
    });
  });

  it.effect('preserves an exact blocking warning and a stale acknowledgement conflict as typed outcomes', () => {
    const warningService = makeQuantityTierAdministration(
      persistence({
        revise: () => Effect.succeed({ acknowledgement, outcome: 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED' }),
      }),
    );
    const staleService = makeQuantityTierAdministration(
      persistence({
        revise: () =>
          Effect.succeed({
            identityKey,
            outcome: 'QUANTITY_TIER_CONFLICT',
            reason: 'ACKNOWLEDGEMENT_STALE',
          }),
      }),
    );
    return Effect.gen(function* warningAndStale() {
      const warning = yield* warningService.revise(valueOnlyCommand);
      expect(warning.outcome).toBe('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      const stale = yield* staleService.revise({ ...valueOnlyCommand, acknowledgement });
      expect(stale).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'ACKNOWLEDGEMENT_STALE' });
    });
  });

  it.effect(
    'accepts retirement only when the replacement preserves exact lineage, value, end, and future schedule',
    () => {
      const effectiveTo = '2026-09-27T11:00:00.000Z' as const;
      const retirement = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
        definition: {
          identityKey,
          revision: {
            effectiveFrom: currentPeriod.effectiveFrom,
            monetaryBoundary: 'PRE_TAX',
            resultingUnitPrice: current.definition.revision.resultingUnitPrice,
            revision: 3,
            revisionId: '99999999-9999-4999-8999-999999999991',
          },
        },
        effectivePeriod: { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo },
        lineage: {
          correctedRevisionId: null,
          kind: 'RETIREMENT',
          previousRevisionId: current.definition.revision.revisionId,
        },
      });
      const retiredSchedule = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
        future: [future],
        identityKey,
        observedAt: '2026-09-27T12:00:00.000Z',
        revisions: [retirement, future],
        scheduleRevision: 3,
      });
      const command: ReviseQuantityTierPersistenceCommand = {
        ...trusted,
        acknowledgement: {
          actingPrincipalId: trusted.actingPrincipalId,
          fingerprint: 'b'.repeat(64),
          identityKey,
          intendedEffectivePeriod: { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo },
          intendedResultingUnitPrice: current.definition.revision.resultingUnitPrice,
          intent: 'RETIRE_CURRENT',
          presentedFuture: [future],
          scheduleRevision: valueOnlyCommand.expectedCurrent.scheduleRevision,
          targetEffectivePeriod: currentPeriod,
          targetRevisionId: current.definition.revision.revisionId,
        },
        effectiveTo,
        expectedCurrent: valueOnlyCommand.expectedCurrent,
        identityKey,
        intent: 'RETIRE_CURRENT',
      };
      const service = makeQuantityTierAdministration(
        persistence({ revise: () => Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: retiredSchedule }) }),
      );
      return Effect.gen(function* retireCurrent() {
        const result = yield* service.revise(command);
        expect(result).toMatchObject({ outcome: 'QUANTITY_TIER_REVISED', schedule: { future: [future] } });
        const invalid = yield* Effect.flip(
          makeQuantityTierAdministration(
            persistence({
              revise: () =>
                Effect.succeed({
                  outcome: 'QUANTITY_TIER_REVISED',
                  schedule: Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
                    ...retiredSchedule,
                    revisions: [
                      { ...retirement, lineage: { ...retirement.lineage, kind: 'VALUE_ONLY_CURRENT' } },
                      future,
                    ],
                  }),
                }),
            }),
          ).revise(command),
        );
        expect(invalid).toBeInstanceOf(QuantityTierPersistenceUnavailable);
      });
    },
  );

  it.effect('accepts correction only when it replaces the exact target interval with correction lineage', () => {
    const correction = Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
      definition: {
        identityKey,
        revision: {
          effectiveFrom: currentPeriod.effectiveFrom,
          monetaryBoundary: 'PRE_TAX',
          resultingUnitPrice: { amount: '88', currencyCode: 'CZK' },
          revision: 3,
          revisionId: '99999999-9999-4999-8999-999999999992',
        },
      },
      effectivePeriod: currentPeriod,
      lineage: {
        correctedRevisionId: current.definition.revision.revisionId,
        kind: 'CORRECTION',
        previousRevisionId: current.definition.revision.revisionId,
      },
    });
    const correctedSchedule = Schema.decodeSync(QuantityTierScheduleSnapshotSchema)({
      current: correction,
      future: [future],
      identityKey,
      observedAt: '2026-09-27T12:00:00.000Z',
      revisions: [correction, future],
      scheduleRevision: 3,
    });
    const command: ReviseQuantityTierPersistenceCommand = {
      ...trusted,
      expectedScheduleRevision: 2,
      identityKey,
      intent: 'CORRECT_REVISION',
      resultingUnitPrice: correction.definition.revision.resultingUnitPrice,
      targetEffectivePeriod: currentPeriod,
      targetRevisionId: current.definition.revision.revisionId,
    };
    const service = makeQuantityTierAdministration(
      persistence({ revise: () => Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: correctedSchedule }) }),
    );
    return Effect.gen(function* correctRevision() {
      const result = yield* service.revise(command);
      expect(result).toMatchObject({ outcome: 'QUANTITY_TIER_REVISED', schedule: { current: correction } });
      const conflict = yield* makeQuantityTierAdministration(
        persistence({
          revise: () =>
            Effect.succeed({ identityKey, outcome: 'QUANTITY_TIER_CONFLICT', reason: 'TARGET_REVISION_NOT_FOUND' }),
        }),
      ).revise(command);
      expect(conflict).toMatchObject({ reason: 'TARGET_REVISION_NOT_FOUND' });
    });
  });

  it.effect('keeps exact absence distinct from an unverifiable mismatched absence', () => {
    const exactService = makeQuantityTierAdministration(
      persistence({
        readCurrent: () => Effect.succeed({ identityKey, outcome: 'QUANTITY_TIER_ABSENT' }),
      }),
    );
    const mismatchedService = makeQuantityTierAdministration(
      persistence({
        readCurrent: () =>
          Effect.succeed({
            identityKey: { ...identityKey, thresholdQuantity: '20' },
            outcome: 'QUANTITY_TIER_ABSENT',
          }),
      }),
    );
    const query = { effectiveAt: '2026-09-27T12:00:00.000Z', identityKey };
    return Effect.gen(function* absenceEvidence() {
      expect(yield* exactService.readCurrent(query)).toEqual({ identityKey, outcome: 'QUANTITY_TIER_ABSENT' });
      const failure = yield* Effect.flip(mismatchedService.readCurrent(query));
      expect(failure).toBeInstanceOf(QuantityTierPersistenceUnavailable);
    });
  });
});

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const currentCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: '2026-09-27T12:00:00.000Z',
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: '2026-09-27T12:00:00.000Z',
    revalidatedAt: '2026-09-27T12:00:00.000Z',
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  generation: 1,
  observedAt: '2026-09-27T12:00:00.000Z',
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};
const actionTrusted = { ...trusted, legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tenantId };
const decodeActionPayload = Schema.decodeUnknownSync(ManageQuantityTierPayloadSchema, { onExcessProperty: 'error' });
const definePayload = decodeActionPayload({
  effectivePeriod: currentPeriod,
  expectedState: { state: 'ABSENT' },
  identityKey,
  intent: 'DEFINE',
  reason: 'Define an exact Quantity Tier through the governed Action',
  resultingUnitPrice: defineCommand.resultingUnitPrice,
});
const valuePayload = decodeActionPayload({
  acknowledgement,
  effectiveFrom: valueChangeEffectiveFrom,
  expectedCurrent: valueOnlyCommand.expectedCurrent,
  identityKey,
  intent: 'VALUE_ONLY_CURRENT',
  reason: 'Change only the Current Tier value',
  resultingUnitPrice: valueOnlyCommand.resultingUnitPrice,
});
const retirePayload = decodeActionPayload({
  effectiveTo: '2026-09-27T18:00:00.000Z',
  expectedCurrent: valueOnlyCommand.expectedCurrent,
  identityKey,
  intent: 'RETIRE_CURRENT',
  reason: 'Retire the exact Current Tier without changing future revisions',
});
const correctPayload = decodeActionPayload({
  expectedScheduleRevision: valueOnlyCommand.expectedCurrent.scheduleRevision,
  identityKey,
  intent: 'CORRECT_REVISION',
  reason: 'Correct the exact historical Tier revision',
  resultingUnitPrice: { amount: '88', currencyCode: 'CZK' },
  targetEffectivePeriod: currentPeriod,
  targetRevisionId: current.definition.revision.revisionId,
});
const actionServices = (overrides: Partial<ManageQuantityTierActionServices>): ManageQuantityTierActionServices => ({
  define: () => Effect.die('unexpected define'),
  loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
  revise: () => Effect.die('unexpected revise'),
  ...overrides,
});

describe('Quantity Tier management Action issue #797', () => {
  it('publishes the generated scoped Action and requires explicit absence for first create', () => {
    expect(manageQuantityTierAction.descriptor).toMatchObject({
      actionKey: 'commerce.pricing.manage-quantity-tier',
      idempotency: 'required',
      legalEntityScope: 'required',
    });
    expect(() => decodeActionPayload({ ...definePayload, storefrontId: 'not-a-tier-axis' })).toThrow();
    expect(() =>
      decodeActionPayload({
        effectivePeriod: currentPeriod,
        identityKey,
        intent: 'DEFINE',
        reason: 'Create without expected absence',
        resultingUnitPrice: defineCommand.resultingUnitPrice,
      }),
    ).toThrow();
  });

  it.effect('binds exact Price, threshold, basis, actor, and expected absence before create', () =>
    Effect.gen(function* createExactTier() {
      let observed: unknown;
      const result = yield* applyQuantityTierManagement(
        definePayload,
        actionTrusted,
        actionServices({
          define: (command) => {
            observed = command;
            return Effect.succeed({ definition: current.definition, outcome: 'QUANTITY_TIER_CREATED' });
          },
        }),
      );
      expect(result.outcome).toBe('QUANTITY_TIER_CREATED');
      expect(observed).toMatchObject({
        actingPrincipalId: trusted.actingPrincipalId,
        effectivePeriod: currentPeriod,
        expectedState: { state: 'ABSENT' },
        identityKey,
      });
    }),
  );

  it.effect('rejects wrong Tenant and EUR before Currency Support or persistence', () =>
    Effect.gen(function* rejectInvalidTier() {
      let reads = 0;
      const services = actionServices({
        loadCurrencySupport: () => {
          reads += 1;
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
      });
      const wrongTenant = yield* applyQuantityTierManagement(
        definePayload,
        { ...actionTrusted, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        services,
      ).pipe(Effect.flip);
      const euro = yield* applyQuantityTierManagement(
        decodeActionPayload({ ...definePayload, resultingUnitPrice: { amount: '90', currencyCode: 'EUR' } }),
        actionTrusted,
        services,
      ).pipe(Effect.flip);
      expect(wrongTenant).toBeInstanceOf(ManageQuantityTierRejected);
      expect(euro).toMatchObject({ code: 'manage_quantity_tier_currency_not_enabled' });
      expect(reads).toBe(0);
    }),
  );

  it.effect('requires the exact Current target and acknowledgement before revision', () =>
    Effect.gen(function* acknowledgeTierFuture() {
      const wrongCurrent = yield* applyQuantityTierManagement(
        decodeActionPayload({
          ...valuePayload,
          expectedCurrent: {
            ...valueOnlyCommand.expectedCurrent,
            identityKey: { ...identityKey, thresholdQuantity: '20' },
          },
        }),
        actionTrusted,
        actionServices({}),
      ).pipe(Effect.flip);
      expect(wrongCurrent).toMatchObject({ code: 'manage_quantity_tier_target_mismatch' });
      const warning = yield* applyQuantityTierManagement(
        decodeActionPayload({
          effectiveFrom: valueChangeEffectiveFrom,
          expectedCurrent: valueOnlyCommand.expectedCurrent,
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Request the exact future schedule before changing Current',
          resultingUnitPrice: valueOnlyCommand.resultingUnitPrice,
        }),
        actionTrusted,
        actionServices({
          revise: () => Effect.succeed({ acknowledgement, outcome: 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED' }),
        }),
      ).pipe(Effect.flip);
      expect(warning).toBeInstanceOf(ManageQuantityTierAcknowledgementRequired);
      expect(warning).toMatchObject({ acknowledgement });
      let observed: unknown;
      const revised = yield* applyQuantityTierManagement(
        valuePayload,
        actionTrusted,
        actionServices({
          revise: (command) => {
            observed = command;
            return Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: revisedSchedule });
          },
        }),
      );
      expect(revised.outcome).toBe('QUANTITY_TIER_REVISED');
      expect(observed).toMatchObject({ acknowledgement, expectedCurrent: valueOnlyCommand.expectedCurrent });
    }),
  );

  it.effect('retires the exact Current interval without requiring a new currency-support fact', () =>
    Effect.gen(function* retireExactCurrent() {
      let currencyReads = 0;
      let observed: unknown;
      const result = yield* applyQuantityTierManagement(
        retirePayload,
        actionTrusted,
        actionServices({
          loadCurrencySupport: () => {
            currencyReads += 1;
            return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
          },
          revise: (command) => {
            observed = command;
            return Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: revisedSchedule });
          },
        }),
      );
      expect(result.outcome).toBe('QUANTITY_TIER_REVISED');
      expect(currencyReads).toBe(0);
      expect(observed).toMatchObject({
        effectiveTo: '2026-09-27T18:00:00.000Z',
        expectedCurrent: valueOnlyCommand.expectedCurrent,
        intent: 'RETIRE_CURRENT',
      });
    }),
  );

  it.effect('corrects only the exact target revision and validates its resulting currency', () =>
    Effect.gen(function* correctExactRevision() {
      let effectiveAt: string | undefined;
      let observed: unknown;
      const result = yield* applyQuantityTierManagement(
        correctPayload,
        actionTrusted,
        actionServices({
          loadCurrencySupport: ({ effectiveAt: queriedEffectiveAt }) => {
            effectiveAt = queriedEffectiveAt;
            return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
          },
          revise: (command) => {
            observed = command;
            return Effect.succeed({ outcome: 'QUANTITY_TIER_REVISED', schedule: revisedSchedule });
          },
        }),
      );
      expect(result.outcome).toBe('QUANTITY_TIER_REVISED');
      expect(effectiveAt).toBe(currentPeriod.effectiveFrom);
      expect(observed).toMatchObject({
        expectedScheduleRevision: valueOnlyCommand.expectedCurrent.scheduleRevision,
        intent: 'CORRECT_REVISION',
        targetEffectivePeriod: currentPeriod,
        targetRevisionId: current.definition.revision.revisionId,
      });
    }),
  );
});
