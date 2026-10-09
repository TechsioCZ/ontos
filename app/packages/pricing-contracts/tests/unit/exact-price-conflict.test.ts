import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupConflictSchema,
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupUnverifiableSchema,
  ExactPriceOwnerLookupResultSchema,
  redactExactPriceConflictDiagnostic,
} from '../../src/domain/exact-price-lookup.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const exactKey = {
  catalogSelection: {
    productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
    variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
  },
  commercialScope: {
    channelId: 'B2C',
    marketId: 'CZ',
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
  ownerRevision: 'pricing-exact-key-current:v2:42',
};
const effectivePeriod = { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null } as const;
const priceRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
});
const claimant = (priceId: string, revisionId: string, priceScheduleRevisionId: string, provenanceRef: string) => ({
  effectivePeriod,
  exactKey,
  priceRef: priceRef(priceId),
  priceRevision: {
    effectiveFrom: effectivePeriod.effectiveFrom,
    monetaryAmount: { amount: '900', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId,
  },
  priceScheduleRevisionId,
  provenanceRefs: [provenanceRef],
  scheduleRevision: 1,
});
const first = claimant(
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
);
const second = claimant(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
);
const diagnostic = {
  _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC' as const,
  claimants: [first, second],
  evidence,
  reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
  request,
  verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET' as const,
};

const decodeDiagnostic = Schema.decodeUnknownSync(ExactPriceConflictDiagnosticSchema, {
  onExcessProperty: 'error',
});
const decodeOwnerResult = Schema.decodeUnknownSync(ExactPriceOwnerLookupResultSchema, {
  onExcessProperty: 'error',
});

describe('issue #764 exact-key Price conflict contract', () => {
  it('treats distinct Current canonical truths as conflict even when their amounts are equal', () => {
    const decoded = decodeDiagnostic(diagnostic);

    expect(decoded.claimants.map(({ priceRevision }) => priceRevision.monetaryAmount.amount)).toEqual(['900', '900']);
    expect(decoded.claimants.map(({ priceRef: ref }) => ref.resourceId)).toEqual([
      first.priceRef.resourceId,
      second.priceRef.resourceId,
    ]);
  });

  it('keeps authorized diagnosis complete and emits a source-redacted public conflict', () => {
    const decoded = decodeDiagnostic(diagnostic);
    const publicConflict = redactExactPriceConflictDiagnostic(decoded);

    expect(Schema.is(ExactPriceLookupConflictSchema)(publicConflict)).toBe(true);
    expect(publicConflict.currentTruthRefs).toEqual([
      { priceRef: first.priceRef, revisionId: first.priceRevision.revisionId },
      { priceRef: second.priceRef, revisionId: second.priceRevision.revisionId },
    ]);
    expect(JSON.stringify(publicConflict)).not.toContain('monetaryAmount');
    expect(JSON.stringify(publicConflict)).not.toContain('provenanceRefs');
    expect(JSON.stringify(publicConflict)).not.toContain('priceScheduleRevisionId');
    expect(JSON.stringify(publicConflict)).not.toContain('effectivePeriod');
  });

  it('rejects replay of the same Price Revision while preserving two Current Revisions of one Price as conflict', () => {
    expect(() => decodeDiagnostic({ ...diagnostic, claimants: [first, first] })).toThrow();

    const anotherRevisionOfFirst = {
      ...second,
      priceRef: first.priceRef,
    };
    expect(decodeDiagnostic({ ...diagnostic, claimants: [first, anotherRevisionOfFirst] }).claimants).toHaveLength(2);
  });

  it('does not fabricate a collision from historical or future non-Current Revisions', () => {
    expect(() =>
      decodeDiagnostic({
        ...diagnostic,
        claimants: [
          first,
          {
            ...second,
            effectivePeriod: {
              effectiveFrom: '2026-10-01T00:00:00.000Z',
              effectiveTo: null,
            },
            priceRevision: {
              ...second.priceRevision,
              effectiveFrom: '2026-10-01T00:00:00.000Z',
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeDiagnostic({
        ...diagnostic,
        claimants: [
          first,
          {
            ...second,
            effectivePeriod: {
              effectiveFrom: '2026-01-01T00:00:00.000Z',
              effectiveTo: effectiveAt,
            },
            priceRevision: {
              ...second.priceRevision,
              effectiveFrom: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects competing claims from a different key axis, including Group versus no-group', () => {
    for (const differentExactKey of [
      { ...exactKey, commercialScope: { ...exactKey.commercialScope, marketId: 'SK' } },
      { ...exactKey, currencyCode: 'EUR' },
      { ...exactKey, priceGroupSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef } },
    ]) {
      expect(() =>
        decodeDiagnostic({
          ...diagnostic,
          claimants: [first, { ...second, exactKey: differentExactKey }],
        }),
      ).toThrow();
    }
  });

  it('treats database-padded quantity basis as the same exact numeric key without rewriting it', () => {
    const databaseClaimant = {
      ...second,
      exactKey: {
        ...second.exactKey,
        unitBasis: { ...second.exactKey.unitBasis, quantity: '1.000000000' },
      },
    };
    const decoded = decodeDiagnostic({ ...diagnostic, claimants: [first, databaseClaimant] });

    expect(decoded.claimants[1]?.exactKey.unitBasis.quantity).toBe('1.000000000');
    expect(decoded.request.exactKey.unitBasis.quantity).toBe('1');
  });

  it('requires complete owner verification and keeps invalid or unverifiable state out of conflict', () => {
    expect(() => decodeDiagnostic({ ...diagnostic, verification: 'UNVERIFIED' })).toThrow();
    expect(
      Schema.is(ExactPriceLookupInvalidSchema)(
        decodeOwnerResult({ _tag: 'INVALID', reason: 'INVALID_CANONICAL_PRICE', request }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ExactPriceLookupUnverifiableSchema)(
        decodeOwnerResult({ _tag: 'UNVERIFIABLE', reason: 'SET_COMPLETENESS_UNVERIFIABLE', request }),
      ),
    ).toBe(true);
    expect(() => decodeDiagnostic({ ...diagnostic, contractualDiscountRevisionId: 'manual-discount' })).toThrow();
  });

  it('keeps generalized native-currency keys without implying FX or Launch activation', () => {
    const eurKey = { ...exactKey, currencyCode: 'EUR' };
    const eurClaimants = [first, second].map((value) => ({
      ...value,
      exactKey: eurKey,
      priceRevision: {
        ...value.priceRevision,
        monetaryAmount: { amount: '900', currencyCode: 'EUR' },
      },
    }));

    expect(
      decodeDiagnostic({
        ...diagnostic,
        claimants: eurClaimants,
        request: { ...request, exactKey: eurKey },
      }).request.exactKey.currencyCode,
    ).toBe('EUR');
  });
});
