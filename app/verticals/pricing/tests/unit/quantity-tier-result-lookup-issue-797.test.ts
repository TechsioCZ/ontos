import { ReadHandlerUnavailable } from '@app/core-runtime';
import {
  QuantityTierDefinitionSchema,
  QuantityTierIdentityKeySchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  QuantityTierResultLookupRequestSchema,
  QuantityTierResultLookupResponseSchema,
} from '../../shared/apis/quantity-tier-result-lookup.ts';
import { QuantityTierActionResultLookupOutcomeSchema } from '../../shared/actions/manage-quantity-tier.ts';
import { readQuantityTierResult } from '../../src/api/quantity-tier-result-lookup.read.ts';
import { QuantityTierPersistenceUnavailable } from '../../src/services/quantity-tier-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const input = Schema.decodeSync(QuantityTierResultLookupRequestSchema)({ actionInvocationId });
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityKey = Schema.decodeSync(QuantityTierIdentityKeySchema)({
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: {
        moduleId: 'commerce.catalog',
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
      unitRef,
      unitRuleRevision: 9,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
});
const definition = Schema.decodeSync(QuantityTierDefinitionSchema)({
  identityKey,
  revision: {
    effectiveFrom: '2026-09-28T00:00:00.000Z',
    monetaryBoundary: 'PRE_TAX',
    resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
    revision: 1,
    revisionId: '77777777-7777-4777-8777-777777777777',
  },
});

describe('Quantity Tier governed result lookup issue #797', () => {
  it.effect('returns the exact original result and binds the trusted acting principal', () =>
    Effect.gen(function* lookupCommittedResult() {
      const found = {
        actionInvocationId,
        outcome: 'QUANTITY_TIER_RESULT_FOUND' as const,
        result: { definition, outcome: 'QUANTITY_TIER_CREATED' as const },
      };
      let observedQuery: unknown;
      const actual = yield* readQuantityTierResult(
        input,
        { principalId },
        {
          lookupResult: (query) => {
            observedQuery = query;
            return Effect.succeed(found);
          },
        },
      );
      expect(observedQuery).toEqual({ actingPrincipalId: principalId, actionInvocationId });
      expect(actual).toEqual(found);
      expect(Schema.is(QuantityTierResultLookupResponseSchema)(actual)).toBe(true);
    }),
  );

  it.effect('returns typed absence and preserves owner persistence failure', () =>
    Effect.gen(function* lookupAbsentOrUnavailable() {
      const absent = { actionInvocationId, outcome: 'QUANTITY_TIER_RESULT_ABSENT' as const };
      const absentResult = yield* readQuantityTierResult(
        input,
        { principalId },
        {
          lookupResult: () => Effect.succeed(absent),
        },
      );
      const failure = yield* readQuantityTierResult(
        input,
        { principalId },
        {
          lookupResult: () =>
            Effect.fail(new QuantityTierPersistenceUnavailable({ reason: 'Owner storage unavailable' })),
        },
      ).pipe(Effect.flip);
      expect(absentResult).toEqual(absent);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(QuantityTierPersistenceUnavailable);
      expect(Schema.is(QuantityTierResultLookupResponseSchema)(absentResult)).toBe(true);
    }),
  );

  it.effect('recovers the exact committed acknowledgement challenge before a new invocation is attempted', () => {
    const found = Schema.decodeSync(QuantityTierActionResultLookupOutcomeSchema)({
      actionInvocationId,
      outcome: 'QUANTITY_TIER_RESULT_FOUND',
      result: {
        acknowledgement: {
          actingPrincipalId: principalId,
          fingerprint: 'a'.repeat(64),
          identityKey,
          intendedEffectivePeriod: { effectiveFrom: '2026-09-28T12:00:00.000Z', effectiveTo: null },
          intendedResultingUnitPrice: { amount: '85', currencyCode: 'CZK' },
          intent: 'VALUE_ONLY_CURRENT',
          presentedFuture: [],
          scheduleRevision: 1,
          targetEffectivePeriod: { effectiveFrom: '2026-09-28T00:00:00.000Z', effectiveTo: null },
          targetRevisionId: definition.revision.revisionId,
        },
        outcome: 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED',
      },
    });
    return readQuantityTierResult(input, { principalId }, { lookupResult: () => Effect.succeed(found) }).pipe(
      Effect.map((actual) => expect(actual).toEqual(found)),
    );
  });
});
