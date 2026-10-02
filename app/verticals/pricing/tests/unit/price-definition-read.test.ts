import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PricePersistenceUnavailable } from '../../src/services/price-persistence.service.ts';
import { readPriceDefinition } from '../../src/api/price-definition.read.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const services = (readCurrent: Parameters<typeof readPriceDefinition>[2]['readCurrent']) => ({
  define: () => Effect.die('not used'),
  readCurrent,
  readSchedule: () => Effect.die('not used'),
  revise: () => Effect.die('not used'),
});
const definition = {
  identityKey: {
    catalogSelection: {
      productRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: 'product-one',
        resourceType: 'commerce.catalog.product' as const,
        tenantId,
      },
      variantRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: 'variant-one',
        resourceType: 'commerce.catalog.variant' as const,
        tenantId,
      },
    },
    commercialScope: { channelId: 'B2C' as const, marketId: 'cz', sellingLegalEntityId: legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' as const },
    unitBasis: {
      quantity: '1',
      unitRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: 'unit-piece',
        resourceType: 'commerce.catalog.product-unit' as const,
        tenantId,
      },
    },
  },
  priceRef,
  revision: {
    effectiveFrom: '2026-09-27T10:00:00.000Z',
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: '55555555-5555-4555-8555-555555555555',
  },
};
const trustedScope = { legalEntityId, tenantId } as const;

describe('Price definition owner read', () => {
  it.effect('preserves typed unknown and currentness-conflict outcomes from owner persistence', () =>
    Effect.gen(function* preserveOutcomes() {
      const unknown = yield* readPriceDefinition(
        { priceRef },
        trustedScope,
        services(() => Effect.succeed({ outcome: 'PRICE_DEFINITION_NOT_FOUND' as const, priceRef })),
      );
      const conflict = yield* readPriceDefinition(
        { priceRef },
        trustedScope,
        services(() =>
          Effect.succeed({
            candidateRevisionIds: [],
            outcome: 'PRICE_DEFINITION_CONFLICT' as const,
            priceRef,
            reason: 'ZERO_CURRENT_REVISION' as const,
          }),
        ),
      );
      expect(unknown.outcome).toBe('PRICE_DEFINITION_NOT_FOUND');
      expect(conflict.outcome).toBe('PRICE_DEFINITION_CONFLICT');
    }),
  );

  it.effect('fails Tenant mismatches closed without owner persistence', () =>
    Effect.gen(function* rejectScopeMismatch() {
      const result = yield* readPriceDefinition(
        { priceRef },
        { legalEntityId, tenantId: '66666666-6666-4666-8666-666666666666' },
        services(() => Effect.die('must not read')),
      );
      expect(result.outcome).toBe('PRICE_DEFINITION_NOT_FOUND');
    }),
  );

  it.effect('maps storage failure to a retryable unavailable outcome without inventing absence', () =>
    Effect.gen(function* mapUnavailable() {
      const result = yield* readPriceDefinition(
        { priceRef },
        trustedScope,
        services(() => Effect.fail(new PricePersistenceUnavailable({ reason: 'database down' }))),
      );
      expect(result).toMatchObject({ outcome: 'PRICE_DEFINITION_UNAVAILABLE', retryable: true });
    }),
  );

  it.effect('fails a cross-SLE persistence result closed instead of exposing another commercial scope', () =>
    Effect.gen(function* rejectCrossSellerResult() {
      const result = yield* readPriceDefinition(
        { priceRef },
        trustedScope,
        services(() =>
          Effect.succeed({
            currentEvidence: {
              observedAt: '2026-09-27T10:00:00.000Z',
              priceRef,
              revision: 1,
              revisionId: definition.revision.revisionId,
            },
            definition: {
              ...definition,
              identityKey: {
                ...definition.identityKey,
                commercialScope: {
                  ...definition.identityKey.commercialScope,
                  sellingLegalEntityId: '77777777-7777-4777-8777-777777777777',
                },
              },
            },
            outcome: 'PRICE_DEFINITION_CURRENT' as const,
          }),
        ),
      );

      expect(result).toMatchObject({ outcome: 'PRICE_DEFINITION_UNAVAILABLE', retryable: true });
    }),
  );
});
