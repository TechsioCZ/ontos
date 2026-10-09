import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PriceDefinitionRequestSchema, PriceDefinitionResponseSchema } from '../../src/apis/price-definition.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const definition = {
  identityKey: {
    catalogSelection: selection,
    commercialScope: {
      channelId: 'B2C',
      marketId: 'cz-launch',
      sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' as const },
    unitBasis: {
      quantity: '1',
      unitRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.catalog.product-unit' as const,
        tenantId,
      },
    },
  },
  priceRef,
  revision: {
    effectiveFrom: '2026-09-27T10:00:00.000Z',
    monetaryAmount: { amount: '0', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
};

const decodeRequest = Schema.decodeUnknownSync(PriceDefinitionRequestSchema, { onExcessProperty: 'error' });
const decodeResponse = Schema.decodeUnknownSync(PriceDefinitionResponseSchema, { onExcessProperty: 'error' });

describe('Pricing Price definition API contract', () => {
  it('reads by stable Price reference without accepting exact-key lookup or caller time', () => {
    expect(decodeRequest({ priceRef })).toEqual({ priceRef });
    expect(() => decodeRequest({ effectiveAt: '2026-09-27T10:00:00.000Z', priceRef })).toThrow();
    expect(() => decodeRequest({ priceRef, storefrontId: 'storefront-web' })).toThrow();
  });

  it('returns the complete current fact with owner observation evidence', () => {
    const current = {
      currentEvidence: {
        observedAt: '2026-09-27T10:00:01.000Z',
        priceRef,
        revision: 1,
        revisionId: definition.revision.revisionId,
      },
      definition,
      outcome: 'PRICE_DEFINITION_CURRENT' as const,
    };

    expect(decodeResponse(current)).toEqual(current);
  });

  it('keeps unknown, conflicting, and unavailable owner states distinct', () => {
    const unknown = { outcome: 'PRICE_DEFINITION_NOT_FOUND' as const, priceRef };
    const conflict = {
      candidateRevisionIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      outcome: 'PRICE_DEFINITION_CONFLICT' as const,
      priceRef,
      reason: 'MULTIPLE_CURRENT_REVISIONS' as const,
    };
    const unavailable = {
      outcome: 'PRICE_DEFINITION_UNAVAILABLE' as const,
      priceRef,
      reason: 'Price storage could not be verified',
      retryable: true as const,
    };

    expect(decodeResponse(unknown)).toEqual(unknown);
    expect(decodeResponse(conflict)).toEqual(conflict);
    expect(decodeResponse(unavailable)).toEqual(unavailable);
  });
});
