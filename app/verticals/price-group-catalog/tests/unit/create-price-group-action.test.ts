import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  createPriceGroupActionProblem,
  mapCreatePriceGroupActionProblem,
} from '../../api/create-price-group-action-problems.ts';
import type { CreatePriceGroupPayload } from '../../shared/actions/create-price-group.ts';
import { createPriceGroupAction, handleCreatePriceGroup } from '../../src/actions/create-price-group.action.ts';
import {
  OutboxPayloadSchema as CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxPayloadSchema,
  outboxProducerModuleKey as CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxProducerModuleKey,
  outboxTopic as CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxTopic,
} from '../../shared/outbox/pricing-price-group-containment-projection-requested.ts';
import type {
  CreatePriceGroupInput,
  PriceGroupCatalogPersistence,
} from '../../src/persistence/price-group-catalog-persistence.ts';
import { PriceGroupCodeConflict, PriceGroupPersistenceUnavailable } from '../../shared/domain/price-group-errors.ts';
import type { PriceGroupDefinitionRevision } from '../../shared/domain/price-group.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const priceGroupId = '44444444-4444-4444-8444-444444444444';
const definitionRevisionId = '55555555-5555-4555-8555-555555555555';
const mutationId = '77777777-7777-4777-8777-777777777777';
const fingerprint = 'a'.repeat(64);
const trustedOperationAt = '2026-09-23T12:00:00.000Z';

const payload: CreatePriceGroupPayload = {
  businessCode: 'DEALER',
  classificationPurpose: 'Classify dealer pricing eligibility.',
  compatibilityContracts: [{ contractId: 'pricing.v1', version: 1 }],
  description: 'Dealer price group.',
  displayName: 'Dealer',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCatalogRevision: 0,
  meaningFingerprint: fingerprint,
  reason: 'Create the initial dealer classification.',
};

const definition: PriceGroupDefinitionRevision = {
  acceptedCatalogRevision: 1,
  classificationPurpose: payload.classificationPurpose,
  compatibilityContracts: payload.compatibilityContracts,
  created: {
    actionInvocationId,
    actorPrincipalId: principalId,
    reason: payload.reason,
    trustedAt: trustedOperationAt,
  },
  definitionRevisionId,
  description: payload.description,
  displayName: payload.displayName,
  effectivePeriod: { effectiveFrom: payload.effectiveFrom, effectiveTo: payload.effectiveTo },
  meaningFingerprint: payload.meaningFingerprint,
  previousDefinitionRevisionId: null,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog',
    resourceId: priceGroupId,
    resourceType: 'pricing.price-group-catalog.price-group',
    tenantId,
  },
  revisionNumber: 1,
};
const createResult = {
  definition,
  outcome: 'RECONCILIATION_REQUIRED' as const,
  reconciliation: {
    mutationId,
    operation: 'touch_containment' as const,
    staged: true as const,
  },
};
const projectionRequest = {
  catalogVersion: '1' as const,
  mutationId,
  operation: 'touch_containment' as const,
  priceGroupRef: definition.priceGroupRef,
  pricingCatalogRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: tenantId,
    resourceType: 'pricing.price-group-catalog.price-group-catalog-root' as const,
    tenantId,
  },
  schemaVersion: '1' as const,
};

const scope = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:create-price-group',
  authMethod: 'session' as const,
  correlationId: 'create-price-group-correlation',
  principalId,
  tenantId,
};

const services = (
  createPriceGroup: PriceGroupCatalogPersistence['createPriceGroup'],
): PriceGroupCatalogPersistence => ({
  createDefinitionRevision: () => Effect.die('unused'),
  createPriceGroup,
  readCurrentDefinition: () => Effect.die('unused'),
  readDefinitionRevision: () => Effect.die('unused'),
  retirePriceGroup: () => Effect.die('unused'),
  validateCompatibility: () => Effect.die('unused'),
});

describe('Create Price Group Action', () => {
  it('declares the catalog permission, forbidden legal-entity scope, and stable event contract', () => {
    const resolveBusinessPermission = getActionBusinessPermissionTargetResolver(createPriceGroupAction);

    expect(createPriceGroupAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(resolveBusinessPermission?.(payload, scope)).toEqual({
      permission: 'pricing.price_group.create',
      target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
    });
    expect(Object.keys(createPriceGroupAction.descriptor.domainEvents)).toEqual([
      'pricing.price-group-catalog.price-group-containment-projection-requested.v1',
    ]);
  });

  it.effect('persists the exact request and records audit, data-access, event, and linked outbox evidence', () =>
    Effect.gen(function* createAndCollectEvidence() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
      const observedInputs: CreatePriceGroupInput[] = [];
      const collector = createActionCollector(
        createPriceGroupAction.descriptor.domainEvents,
        'pricing.price-group-catalog',
        createPriceGroupAction.descriptor.accessEvidencePolicy,
        createPriceGroupAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* handleCreatePriceGroup(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: services((input) => {
          observedInputs.push(input);
          return Effect.succeed(createResult);
        }),
      });

      expect(result).toEqual(createResult);
      expect(observedInputs).toEqual([
        {
          actingPrincipalId: principalId,
          actionInvocationId,
          businessCode: payload.businessCode,
          classificationPurpose: payload.classificationPurpose,
          compatibilityContracts: payload.compatibilityContracts,
          description: payload.description,
          displayName: payload.displayName,
          effectiveFrom: new Date(payload.effectiveFrom),
          expectedCatalogRevision: payload.expectedCatalogRevision,
          meaningFingerprint: payload.meaningFingerprint,
          reason: payload.reason,
          trustedEffectiveAt: new Date(trustedOperationAt),
        },
      ]);
      expect(observedInputs[0]?.effectiveTo).toBeUndefined();

      const evidence = collector.snapshot();
      expect(evidence.auditEvidence).toEqual({
        expectedCatalogRevision: payload.expectedCatalogRevision,
        reason: payload.reason,
      });
      expect(evidence.dataAccessEvents).toMatchObject([
        {
          accessKind: 'read',
          queryHash: `price-group-create:${payload.businessCode}`,
          resultCount: 0,
          servingModuleKey: 'pricing.price-group-catalog',
          targetModuleKey: 'pricing.price-group-catalog',
          targetResourceId: priceGroupId,
          targetResourceType: 'pricing.price-group-catalog.price-group',
        },
      ]);
      expect(evidence.domainEvents).toMatchObject([
        {
          eventType: 'pricing.price-group-catalog.price-group-containment-projection-requested.v1',
          payloadJson: projectionRequest,
          producerModuleKey: 'pricing.price-group-catalog',
          subjectResourceId: priceGroupId,
        },
      ]);
      expect(evidence.outboxMessages).toMatchObject([
        {
          message: {
            payloadJson: projectionRequest,
            producerModuleKey: CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxProducerModuleKey,
            topic: CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxTopic,
          },
        },
      ]);
      expect(
        Schema.decodeUnknownSync(CreatePriceGroupPricingPriceGroupContainmentProjectionRequestedOutboxPayloadSchema)(
          projectionRequest,
        ),
      ).toEqual(projectionRequest);
    }),
  );

  it.effect('preserves typed persistence failures without collecting success evidence', () =>
    Effect.gen(function* preserveTypedFailure() {
      const failure = new PriceGroupCodeConflict({
        code: 'price_group_code_conflict',
        conflictingCode: payload.businessCode,
        reason: 'The business code already exists.',
      });
      const collector = createActionCollector(
        createPriceGroupAction.descriptor.domainEvents,
        'pricing.price-group-catalog',
        createPriceGroupAction.descriptor.accessEvidencePolicy,
        createPriceGroupAction.descriptor.auditEvidenceSchema,
      );
      const actual = yield* handleCreatePriceGroup(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: services(() => Effect.fail(failure)),
      }).pipe(Effect.flip);

      expect(actual).toBe(failure);
      expect(collector.snapshot()).toMatchObject({ dataAccessEvents: [], domainEvents: [], outboxMessages: [] });
    }),
  );

  it('maps owner failures to stable HTTP problem categories', () => {
    expect(
      mapCreatePriceGroupActionProblem(
        new PriceGroupCodeConflict({
          code: 'price_group_code_conflict',
          conflictingCode: payload.businessCode,
          reason: 'The business code already exists.',
        }),
      ),
    ).toMatchObject({ code: 'price_group_code_conflict', status: 409 });
    expect(
      mapCreatePriceGroupActionProblem(
        new PriceGroupPersistenceUnavailable({
          code: 'price_group_persistence_unavailable',
          reason: 'Persistence is unavailable.',
          retryable: true,
        }),
      ),
    ).toEqual(createPriceGroupActionProblem.unavailable('price_group_persistence_unavailable'));
  });
});
