import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { mapCreatePriceGroupDefinitionRevisionActionProblem } from '../../api/create-price-group-definition-revision-action-problems.ts';
import { CreatePriceGroupDefinitionRevisionPayloadSchema } from '../../shared/actions/create-price-group-definition-revision.ts';
import {
  PriceGroupEffectivePeriodConflict,
  PriceGroupExpectedCurrentConflict,
  PriceGroupMeaningChangeRequired,
} from '../../shared/domain/price-group-errors.ts';
import { PriceGroupDefinitionRevisionSchema } from '../../shared/domain/price-group.ts';
import {
  createPriceGroupDefinitionRevisionAction,
  handleCreatePriceGroupDefinitionRevision,
} from '../../src/actions/create-price-group-definition-revision.action.ts';
import type { PriceGroupCatalogPersistence } from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const previousDefinitionRevisionId = '44444444-4444-4444-8444-444444444444';
const definitionRevisionId = '55555555-5555-4555-8555-555555555555';
const fingerprint = 'a'.repeat(64);
const trustedOperationAt = '2026-09-23T12:00:00.000Z';
const payload = Schema.decodeUnknownSync(CreatePriceGroupDefinitionRevisionPayloadSchema)({
  classificationPurpose: 'Customer commercial classification',
  compatibilityContracts: [{ contractId: 'customer.price-group.v1', version: 1 }],
  description: 'Updated presentation with unchanged commercial meaning.',
  displayName: 'Wholesale customers',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCurrent: {
    catalogRevision: 7,
    definitionRevisionId: previousDefinitionRevisionId,
    definitionRevisionNumber: 1,
    meaningFingerprint: fingerprint,
    priceGroupRef,
  },
  meaningFingerprint: fingerprint,
  reason: 'Clarify operator-facing wording',
  sameMeaningAttested: true,
});
const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 8,
  classificationPurpose: payload.classificationPurpose,
  compatibilityContracts: payload.compatibilityContracts,
  created: {
    actionInvocationId: '66666666-6666-4666-8666-666666666666',
    actorPrincipalId: principalId,
    reason: payload.reason,
    trustedAt: trustedOperationAt,
  },
  definitionRevisionId,
  description: payload.description,
  displayName: payload.displayName,
  effectivePeriod: { effectiveFrom: payload.effectiveFrom, effectiveTo: payload.effectiveTo },
  meaningFingerprint: payload.meaningFingerprint,
  previousDefinitionRevisionId,
  priceGroupRef,
  revisionNumber: 2,
});
const scope = {
  authMethod: 'session' as const,
  correlationId: 'price-group-revision-test',
  principalId,
  tenantId,
};
const unused = () => Effect.die('unused persistence operation');
const services = (
  createDefinitionRevision: PriceGroupCatalogPersistence['createDefinitionRevision'],
): PriceGroupCatalogPersistence => ({
  createDefinitionRevision,
  createPriceGroup: unused,
  readCurrentDefinition: unused,
  readDefinitionRevision: unused,
  retirePriceGroup: unused,
  validateCompatibility: unused,
});

it('requires the exact revision permission on the payload Price Group and forbids Legal Entity scope', () => {
  expect(createPriceGroupDefinitionRevisionAction.descriptor.legalEntityScope).toBe('forbidden');
  expect(getActionBusinessPermissionTargetResolver(createPriceGroupDefinitionRevisionAction)?.(payload, scope)).toEqual(
    {
      permission: 'pricing.price_group.revision.create',
      target: {
        kind: 'price_group',
        priceGroupId: priceGroupRef.resourceId,
        pricingCatalogId: tenantId,
        tenantId,
      },
    },
  );

  const crossTenantPayload = {
    ...payload,
    expectedCurrent: {
      ...payload.expectedCurrent,
      priceGroupRef: { ...priceGroupRef, tenantId: '77777777-7777-4777-8777-777777777777' },
    },
  };
  expect(
    getActionBusinessPermissionTargetResolver(createPriceGroupDefinitionRevisionAction)?.(crossTenantPayload, scope),
  ).toMatchObject({
    target: {
      pricingCatalogId: '77777777-7777-4777-8777-777777777777',
      tenantId: '77777777-7777-4777-8777-777777777777',
    },
  });
});

it.effect('persists expected-current evidence and emits the revision event with its attached outbox message', () =>
  Effect.gen(function* createsRevision() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
    let persistedInput: unknown;
    const collector = createActionCollector(
      createPriceGroupDefinitionRevisionAction.descriptor.domainEvents,
      'pricing.price-group-catalog',
      createPriceGroupDefinitionRevisionAction.descriptor.accessEvidencePolicy,
      createPriceGroupDefinitionRevisionAction.descriptor.auditEvidenceSchema,
    );
    const result = yield* handleCreatePriceGroupDefinitionRevision(payload, {
      actionInvocationId: '66666666-6666-4666-8666-666666666666',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: services((input) => {
        persistedInput = input;
        return Effect.succeed(definition);
      }),
    });

    expect(result).toEqual(definition);
    expect(persistedInput).toMatchObject({
      expectedCurrent: payload.expectedCurrent,
      meaningFingerprint: fingerprint,
      reason: payload.reason,
      trustedEffectiveAt: new Date(trustedOperationAt),
    });
    const evidence = collector.snapshot();
    expect(evidence.auditEvidence).toEqual({
      expectedCatalogRevision: 7,
      expectedDefinitionRevisionId: previousDefinitionRevisionId,
      expectedDefinitionRevisionNumber: 1,
      reason: payload.reason,
      sameMeaningAttested: true,
    });
    expect(evidence.dataAccessEvents).toHaveLength(1);
    expect(evidence.domainEvents).toMatchObject([
      {
        eventType: 'pricing.price-group-catalog.price-group-definition-revision-created.v1',
        payloadJson: definition,
        subjectResourceId: priceGroupRef.resourceId,
      },
    ]);
    expect(evidence.outboxMessages).toMatchObject([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: definition,
          producerModuleKey: 'pricing.price-group-catalog',
          topic: 'pricing.price-group.definition-revision-created',
        },
      },
    ]);
  }),
);

it.effect('preserves a stale expected-current conflict as a typed domain failure without evidence', () =>
  Effect.gen(function* staleRevision() {
    const failure = new PriceGroupExpectedCurrentConflict({
      code: 'price_group_expected_current_conflict',
      priceGroupRef,
      reason: 'Expected Current evidence does not match owner state',
    });
    const collector = createActionCollector(
      createPriceGroupDefinitionRevisionAction.descriptor.domainEvents,
      'pricing.price-group-catalog',
      createPriceGroupDefinitionRevisionAction.descriptor.accessEvidencePolicy,
      createPriceGroupDefinitionRevisionAction.descriptor.auditEvidenceSchema,
    );
    const observedFailure = yield* Effect.flip(
      handleCreatePriceGroupDefinitionRevision(payload, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: services(() => Effect.fail(failure)),
      }),
    );
    expect(observedFailure).toEqual(failure);
    expect(collector.snapshot()).toMatchObject({ dataAccessEvents: [], domainEvents: [], outboxMessages: [] });
  }),
);

it('maps material meaning changes to the declared conflict response', () => {
  const problem = mapCreatePriceGroupDefinitionRevisionActionProblem(
    new PriceGroupMeaningChangeRequired({
      code: 'price_group_meaning_change_requires_new_identity',
      priceGroupRef,
      reason: 'A material meaning change requires a new identity',
    }),
  );
  expect(problem).toMatchObject({
    code: 'price_group_meaning_change_requires_new_identity',
    status: 409,
  });
});

it('maps effective periods before trusted operation time to a stable conflict response', () => {
  const problem = mapCreatePriceGroupDefinitionRevisionActionProblem(
    new PriceGroupEffectivePeriodConflict({
      code: 'price_group_effective_period_conflict',
      effectiveFrom: payload.effectiveFrom,
      priceGroupRef,
      reason: 'A new Price Group definition cannot become effective before its trusted operation time',
      trustedEffectiveAt: trustedOperationAt,
    }),
  );
  expect(problem).toMatchObject({
    code: 'price_group_effective_period_conflict',
    status: 409,
  });
});
