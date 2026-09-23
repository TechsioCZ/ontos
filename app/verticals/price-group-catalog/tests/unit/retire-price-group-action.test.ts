import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  mapRetirePriceGroupActionProblem,
  retirePriceGroupActionProblem,
} from '../../api/retire-price-group-action-problems.ts';
import { RetirePriceGroupPayloadSchema } from '../../shared/actions/retire-price-group.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupExpectedCurrentConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupLifecycleConflict,
  PriceGroupPersistenceUnavailable,
  PriceGroupRetirementEffectiveTimeConflict,
} from '../../shared/domain/price-group-errors.ts';
import { PriceGroupRetirementAcceptanceSchema } from '../../shared/domain/price-group.ts';
import { OutboxPayloadSchema as RetirePriceGroupPricingPriceGroupRetirementAcceptedOutboxPayloadSchema } from '../../shared/outbox/pricing-price-group-retirement-accepted.ts';
import { handleRetirePriceGroup, retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';
import type {
  PriceGroupCatalogPersistence,
  RetirePriceGroupInput,
} from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const trustedOperationAt = '2026-09-30T00:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(RetirePriceGroupPayloadSchema)({
  effectiveAt: '2026-10-01T00:00:00.000Z',
  expectedCurrent: {
    catalogRevision: 7,
    definitionRevisionId,
    definitionRevisionNumber: 3,
    meaningFingerprint: 'a'.repeat(64),
    priceGroupRef,
  },
  reason: 'Retire this classification from future commercial use.',
});
const persistedRetirement = Schema.decodeUnknownSync(PriceGroupRetirementAcceptanceSchema)({
  acceptedCatalogRevision: 11,
  currentDefinitionRevisionId: definitionRevisionId,
  currentDefinitionRevisionNumber: 3,
  priceGroupRef,
  retirementEffectiveAt: payload.effectiveAt,
  retirementProvenance: {
    actionInvocationId,
    actorPrincipalId: principalId,
    reason: payload.reason,
    trustedAt: trustedOperationAt,
  },
  trustedOperationAt,
  verifiedAt: trustedOperationAt,
});
const scope = {
  authMethod: 'session' as const,
  correlationId: 'retire-price-group-test',
  principalId,
  tenantId,
};
const unused = () => Effect.die('unused persistence operation');
const services = (
  retirePriceGroup: PriceGroupCatalogPersistence['retirePriceGroup'],
): PriceGroupCatalogPersistence => ({
  createDefinitionRevision: unused,
  createPriceGroup: unused,
  readCurrentDefinition: unused,
  readDefinitionRevision: unused,
  retirePriceGroup,
  validateCompatibility: unused,
});

it('requires the exact Price Group permission from the payload and forbids Legal Entity scope', () => {
  const resolve = getActionBusinessPermissionTargetResolver(retirePriceGroupAction);
  expect(retirePriceGroupAction.descriptor.legalEntityScope).toBe('forbidden');
  expect(resolve?.(payload, scope)).toEqual({
    permission: 'pricing.price_group.retire',
    target: {
      kind: 'price_group',
      priceGroupId: priceGroupRef.resourceId,
      pricingCatalogId: tenantId,
      tenantId,
    },
  });

  const foreignTenantId = '88888888-8888-4888-8888-888888888888';
  expect(
    resolve?.(
      {
        ...payload,
        expectedCurrent: {
          ...payload.expectedCurrent,
          priceGroupRef: { ...priceGroupRef, tenantId: foreignTenantId },
        },
      },
      scope,
    ),
  ).toMatchObject({ target: { pricingCatalogId: foreignTenantId, tenantId: foreignTenantId } });
});

it.effect('persists a scheduled terminal transition and records separate trusted evidence with its linked outbox', () =>
  Effect.gen(function* retireAndCollectEvidence() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
    const observedInputs: RetirePriceGroupInput[] = [];
    const collector = createActionCollector(
      retirePriceGroupAction.descriptor.domainEvents,
      'pricing.price-group-catalog',
      retirePriceGroupAction.descriptor.accessEvidencePolicy,
      retirePriceGroupAction.descriptor.auditEvidenceSchema,
    );
    const result = yield* handleRetirePriceGroup(payload, {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: services((input) => {
        observedInputs.push(input);
        return Effect.succeed(persistedRetirement);
      }),
    });

    expect(observedInputs).toEqual([
      {
        actingPrincipalId: principalId,
        actionInvocationId,
        effectiveAt: new Date(payload.effectiveAt),
        expectedCurrent: payload.expectedCurrent,
        reason: payload.reason,
        trustedEffectiveAt: new Date(trustedOperationAt),
      },
    ]);
    expect(observedInputs[0]?.effectiveAt.getTime()).toBeGreaterThan(new Date(trustedOperationAt).getTime());
    expect(Schema.decodeUnknownSync(PriceGroupRetirementAcceptanceSchema)(result)).toEqual(result);
    expect(result).toMatchObject({
      acceptedCatalogRevision: 11,
      currentDefinitionRevisionId: definitionRevisionId,
      currentDefinitionRevisionNumber: 3,
      priceGroupRef,
      retirementEffectiveAt: payload.effectiveAt,
      retirementProvenance: {
        actionInvocationId,
        actorPrincipalId: principalId,
        reason: payload.reason,
        trustedAt: trustedOperationAt,
      },
    });
    const evidence = collector.snapshot();
    expect(evidence.auditEvidence).toEqual({
      effectiveAt: payload.effectiveAt,
      expectedCurrent: payload.expectedCurrent,
      reason: payload.reason,
      trustedEffectiveAt: trustedOperationAt,
    });
    expect(evidence.dataAccessEvents).toMatchObject([
      {
        accessKind: 'read',
        queryHash: `price-group-retire:${priceGroupRef.resourceId}`,
        resultCount: 1,
        targetResourceId: priceGroupRef.resourceId,
      },
    ]);
    expect(evidence.domainEvents).toMatchObject([
      {
        eventType: 'pricing.price-group-catalog.price-group-retirement-accepted.v1',
        payloadJson: result,
        subjectResourceId: priceGroupRef.resourceId,
      },
    ]);
    expect(evidence.outboxMessages).toMatchObject([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: result,
          producerModuleKey: 'pricing.price-group-catalog',
          topic: 'pricing.price-group.retirement-accepted',
        },
      },
    ]);
    expect(
      Schema.decodeUnknownSync(RetirePriceGroupPricingPriceGroupRetirementAcceptedOutboxPayloadSchema)(result),
    ).toEqual(result);
  }),
);

it.effect('returns equivalent evidence for an owner-confirmed equivalent retry', () =>
  Effect.gen(function* equivalentRetry() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
    const execute = () => {
      const collector = createActionCollector(
        retirePriceGroupAction.descriptor.domainEvents,
        'pricing.price-group-catalog',
        retirePriceGroupAction.descriptor.accessEvidencePolicy,
        retirePriceGroupAction.descriptor.auditEvidenceSchema,
      );
      return handleRetirePriceGroup(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: services(() => Effect.succeed(persistedRetirement)),
      });
    };
    expect(yield* execute()).toEqual(yield* execute());
  }),
);

it.effect('preserves stale, lifecycle, and currentness failures without success evidence', () =>
  Effect.gen(function* preserveOwnerFailures() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
    const failures = [
      new PriceGroupExpectedCurrentConflict({
        code: 'price_group_expected_current_conflict',
        priceGroupRef,
        reason: 'Expected Current evidence is stale.',
      }),
      new PriceGroupLifecycleConflict({
        code: 'price_group_lifecycle_conflict',
        priceGroupRef,
        reason: 'A retired Price Group is terminal.',
      }),
      new PriceGroupCurrentnessFailure({
        candidateDefinitionRevisionIds: [],
        code: 'price_group_currentness_failure',
        priceGroupRef,
        reason: 'ZERO_CURRENT_DEFINITIONS',
      }),
    ] as const;

    for (const failure of failures) {
      const collector = createActionCollector(
        retirePriceGroupAction.descriptor.domainEvents,
        'pricing.price-group-catalog',
        retirePriceGroupAction.descriptor.accessEvidencePolicy,
        retirePriceGroupAction.descriptor.auditEvidenceSchema,
      );
      expect(
        yield* handleRetirePriceGroup(payload, {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: services(() => Effect.fail(failure)),
        }).pipe(Effect.flip),
      ).toBe(failure);
      expect(collector.snapshot()).toMatchObject({ dataAccessEvents: [], domainEvents: [], outboxMessages: [] });
    }
  }),
);

it.effect('rejects a backdated retirement instant before persistence with a typed conflict', () =>
  Effect.gen(function* rejectBackdatedRetirement() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
    let persistenceCalled = false;
    const collector = createActionCollector(
      retirePriceGroupAction.descriptor.domainEvents,
      'pricing.price-group-catalog',
      retirePriceGroupAction.descriptor.accessEvidencePolicy,
      retirePriceGroupAction.descriptor.auditEvidenceSchema,
    );
    const backdatedEffectiveAt = '2026-09-29T00:00:00.000Z';
    const failure = yield* handleRetirePriceGroup(
      { ...payload, effectiveAt: backdatedEffectiveAt },
      {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: services(() => {
          persistenceCalled = true;
          return Effect.succeed(persistedRetirement);
        }),
      },
    ).pipe(Effect.flip);

    expect(failure).toEqual(
      new PriceGroupRetirementEffectiveTimeConflict({
        code: 'price_group_retirement_effective_time_conflict',
        effectiveAt: backdatedEffectiveAt,
        priceGroupRef,
        reason: 'Price Group retirement cannot become effective before its trusted operation time',
        trustedEffectiveAt: trustedOperationAt,
      }),
    );
    expect(persistenceCalled).toBe(false);
    expect(collector.snapshot()).toMatchObject({ dataAccessEvents: [], domainEvents: [], outboxMessages: [] });
    expect(mapRetirePriceGroupActionProblem(failure)).toMatchObject({
      code: 'price_group_retirement_effective_time_conflict',
      status: 409,
    });
  }),
);

it('maps stale, lifecycle, currentness, idempotency, and persistence failures to stable HTTP problems', () => {
  const conflictFailures = [
    new PriceGroupExpectedCurrentConflict({
      code: 'price_group_expected_current_conflict',
      priceGroupRef,
      reason: 'Expected Current evidence is stale.',
    }),
    new PriceGroupLifecycleConflict({
      code: 'price_group_lifecycle_conflict',
      priceGroupRef,
      reason: 'A retired Price Group is terminal.',
    }),
    new PriceGroupIdempotencyReuseConflict({
      actionInvocationId,
      code: 'price_group_idempotency_reuse_conflict',
      reason: 'The invocation belongs to a different operation.',
    }),
    new PriceGroupRetirementEffectiveTimeConflict({
      code: 'price_group_retirement_effective_time_conflict',
      effectiveAt: '2026-09-29T00:00:00.000Z',
      priceGroupRef,
      reason: 'Price Group retirement cannot become effective before its trusted operation time',
      trustedEffectiveAt: trustedOperationAt,
    }),
  ];
  for (const failure of conflictFailures) {
    expect(mapRetirePriceGroupActionProblem(failure)).toMatchObject({ code: failure.code, status: 409 });
  }
  const currentness = new PriceGroupCurrentnessFailure({
    candidateDefinitionRevisionIds: [],
    code: 'price_group_currentness_failure',
    priceGroupRef,
    reason: 'ZERO_CURRENT_DEFINITIONS',
  });
  expect(mapRetirePriceGroupActionProblem(currentness)).toEqual(
    retirePriceGroupActionProblem.unavailable('price_group_currentness_failure'),
  );
  const persistence = new PriceGroupPersistenceUnavailable({
    code: 'price_group_persistence_unavailable',
    reason: 'Persistence is unavailable.',
    retryable: true,
  });
  expect(mapRetirePriceGroupActionProblem(persistence)).toEqual(
    retirePriceGroupActionProblem.unavailable('price_group_persistence_unavailable'),
  );
});
