import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceLookupAbsentSchema,
  ExactPriceLookupConflictSchema,
  ExactPriceLookupFoundSchema,
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupRequestSchema,
  ExactPriceLookupResultSchema,
  ExactPriceLookupUnavailableSchema,
  ExactPriceLookupUnverifiableSchema,
} from '../../src/domain/exact-price-lookup.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const exactKey = {
  catalogSelection: {
    productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
    variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
  },
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
  },
};
const request = { effectiveAt, exactKey };
const evidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt: '2026-09-27T12:00:00.050Z',
  ownerRevision: 'pricing-exact-key-current:v1:41',
};
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.price',
  tenantId,
} as const;
const priceRevision = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  monetaryAmount: { amount: '900', currencyCode: 'CZK' },
  monetaryBoundary: 'PRE_TAX' as const,
  revision: 2,
  revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const decodeRequest = Schema.decodeUnknownSync(ExactPriceLookupRequestSchema, { onExcessProperty: 'error' });
const decodeResult = Schema.decodeUnknownSync(ExactPriceLookupResultSchema, { onExcessProperty: 'error' });

describe('exact Price Current lookup contract', () => {
  it('keeps zero, one, and competing canonical Current truths explicit', () => {
    expect(Schema.is(ExactPriceLookupAbsentSchema)(decodeResult({ _tag: 'ABSENT', evidence, request }))).toBe(true);
    expect(
      Schema.is(ExactPriceLookupFoundSchema)(
        decodeResult({ _tag: 'FOUND', evidence, priceRef, priceRevision, request }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ExactPriceLookupConflictSchema)(
        decodeResult({
          _tag: 'CONFLICT',
          currentTruthRefs: [
            { priceRef, revisionId: priceRevision.revisionId },
            {
              priceRef: { ...priceRef, resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
              revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            },
          ],
          evidence,
          reason: 'COMPETING_CURRENT_EXACT_PRICES',
          request,
        }),
      ),
    ).toBe(true);
  });

  it('does not turn replay of the same canonical owner fact into a collision', () => {
    expect(() =>
      decodeResult({
        _tag: 'CONFLICT',
        currentTruthRefs: [
          { priceRef, revisionId: priceRevision.revisionId },
          { priceRef, revisionId: priceRevision.revisionId },
        ],
        evidence,
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        request,
      }),
    ).toThrow();
    const found = decodeResult({ _tag: 'FOUND', evidence, priceRef, priceRevision, request });
    expect(Schema.is(ExactPriceLookupFoundSchema)(found)).toBe(true);
    expect(found).toMatchObject({ priceRef });
  });

  it('binds FOUND to the exact Tenant, native currency, trusted instant, and effective Revision', () => {
    expect(() =>
      decodeResult({
        _tag: 'FOUND',
        evidence,
        priceRef: { ...priceRef, tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
        priceRevision,
        request,
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'FOUND',
        evidence,
        priceRef,
        priceRevision: { ...priceRevision, monetaryAmount: { amount: '900', currencyCode: 'EUR' } },
        request,
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'FOUND',
        evidence,
        priceRef,
        priceRevision: { ...priceRevision, effectiveFrom: '2026-09-28T00:00:00.000Z' },
        request,
      }),
    ).toThrow();
  });

  it('requires owner Current-set evidence for absence and collision', () => {
    for (const invalidEvidence of [
      { ...evidence, effectiveAt: '2026-09-26T12:00:00.000Z' },
      { ...evidence, observedAt: '2026-09-26T12:00:00.000Z' },
      { ...evidence, nextApplicabilityBoundary: evidence.observedAt },
      { ...evidence, ownerRevision: '  ' },
    ]) {
      expect(() => decodeResult({ _tag: 'ABSENT', evidence: invalidEvidence, request })).toThrow();
    }
  });

  it('keeps invalid, unavailable, and unverifiable states distinct', () => {
    expect(
      Schema.is(ExactPriceLookupInvalidSchema)(
        decodeResult({ _tag: 'INVALID', reason: 'PRICE_KEY_MISMATCH', request }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ExactPriceLookupUnavailableSchema)(
        decodeResult({ _tag: 'UNAVAILABLE', reason: 'EXACT_LOOKUP_UNAVAILABLE', request }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ExactPriceLookupUnverifiableSchema)(
        decodeResult({ _tag: 'UNVERIFIABLE', reason: 'SET_COMPLETENESS_UNVERIFIABLE', request }),
      ),
    ).toBe(true);
  });

  it('rejects Storefront, cross-currency, and wildcard widening in the exact key', () => {
    expect(() => decodeRequest({ ...request, exactKey: { ...exactKey, storefrontId: 'web' } })).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        exactKey: { ...exactKey, commercialScope: { ...exactKey.commercialScope, marketId: '*' } },
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'FOUND',
        evidence,
        priceRef,
        priceRevision: { ...priceRevision, monetaryAmount: { amount: '40', currencyCode: 'EUR' } },
        request,
      }),
    ).toThrow();
  });
});
