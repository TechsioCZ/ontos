import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PriceGroupDefinitionResponseSchema } from '../../shared/apis/price-group-definition.ts';
import { PriceGroupDefinitionRevisionSchema, PriceGroupIdentitySchema } from '../../shared/domain/price-group.ts';
import { readPriceGroupDefinition } from '../../src/api/price-group-definition.read.ts';
import type { PriceGroupCatalogPersistence } from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = '334b0000-0000-4000-8000-000000000001';
const revisionId = '334b0000-0000-4000-8000-000000000002';
const retiredAt = '2026-09-25T00:00:00.000Z';
const beforeRetirement = '2026-09-24T23:59:59.999Z';
const afterRetirement = '2026-09-26T00:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '334b0000-0000-4000-8000-000000000003',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 1,
  classificationPurpose: 'A stable dealer classification.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment.v1', version: 1 }],
  created: {
    actionInvocationId: '334b0000-0000-4000-8000-000000000004',
    actorPrincipalId: '334b0000-0000-4000-8000-000000000005',
    reason: 'Accept the original definition.',
    trustedAt: '2026-09-01T00:00:00.000Z',
  },
  definitionRevisionId: revisionId,
  description: 'The accepted schedule remains immutable after retirement.',
  displayName: 'Dealer',
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  meaningFingerprint: 'b'.repeat(64),
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
  semanticContinuity: null,
});
const scheduledRetirement = {
  acceptedCatalogRevision: 2,
  currentDefinitionRevisionId: revisionId,
  currentDefinitionRevisionNumber: 1,
  priceGroupRef,
  retirementEffectiveAt: retiredAt,
  retirementProvenance: definition.created,
  trustedOperationAt: definition.created.trustedAt,
  verifiedAt: '2026-09-01T00:00:01.000Z',
};

it.effect('B4 validates historical lifecycle at the requested instant, not the response wall clock', () =>
  Effect.gen(function* historicalLifecycleObservation() {
    const services: PriceGroupCatalogPersistence = {
      createDefinitionRevision: () => Effect.die('Unexpected revision write'),
      createPriceGroup: () => Effect.die('Unexpected group write'),
      readCurrentDefinition: () => Effect.die('Historical reads must not select Current'),
      readDefinitionRevision: (ref, requestedRevisionId, at) => {
        expect(ref).toEqual(priceGroupRef);
        expect(requestedRevisionId).toBe(revisionId);
        const retired = at.toISOString() >= retiredAt;
        return Effect.succeed({
          definition,
          identity: Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
            businessCode: 'DEALER',
            created: definition.created,
            createdAtCatalogRevision: 1,
            lifecycle: {
              activeFrom: definition.effectivePeriod.effectiveFrom,
              retiredAt: retired ? retiredAt : null,
              state: retired ? 'RETIRED' : 'ACTIVE',
            },
            meaningFingerprint: definition.meaningFingerprint,
            priceGroupRef,
          }),
          scheduledRetirement,
        });
      },
      retirePriceGroup: () => Effect.die('Unexpected retirement write'),
      validateCompatibility: () => Effect.die('Historical reads do not certify Current compatibility'),
    };
    for (const servedAt of [beforeRetirement, afterRetirement]) {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(servedAt)));
      for (const trustedOperationAt of [beforeRetirement, retiredAt, afterRetirement]) {
        const response = yield* readPriceGroupDefinition(
          { definitionRevisionId: revisionId, priceGroupRef, trustedOperationAt },
          tenantId,
          services,
        );
        const decoded = yield* Schema.decodeUnknownEffect(PriceGroupDefinitionResponseSchema)(response);
        expect(decoded.observedAt).toBe(trustedOperationAt);
        expect(decoded.definition).toEqual(definition);
        expect(decoded.identity.lifecycle.state).toBe(trustedOperationAt < retiredAt ? 'ACTIVE' : 'RETIRED');
        expect('currentEvidence' in decoded).toBe(false);
        const wrongSideOfBoundary = trustedOperationAt < retiredAt ? afterRetirement : beforeRetirement;
        const invalidObservation = { ...decoded, observedAt: wrongSideOfBoundary };
        expect(Schema.is(PriceGroupDefinitionResponseSchema)(invalidObservation)).toBe(false);
      }
    }
  }),
);
