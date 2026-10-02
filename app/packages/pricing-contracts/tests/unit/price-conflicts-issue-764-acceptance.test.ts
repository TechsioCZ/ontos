import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupConflictSchema,
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

const selection = {
  packageOption: {
    contentRevision: {
      resourceRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
      revision: 5,
    },
    optionRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
  },
  productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
  variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
} as const;

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;

const exactKey = {
  catalogSelection: selection,
  commercialScope: {
    channelId: 'B2C',
    marketId: 'CZ',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
  },
} as const;

const request = { effectiveAt, exactKey } as const;
const evidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt: '2026-09-27T12:00:00.050Z',
  ownerRevision: 'pricing-current-state:41',
} as const;

const claimant = (resourceId: string, revisionId: string, amount: string, provenanceRef: string) => ({
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  exactKey,
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId,
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount, currencyCode: exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX',
    revision: 1,
    revisionId,
  },
  priceScheduleRevisionId: `${resourceId.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  provenanceRefs: [provenanceRef],
  scheduleRevision: 1,
});

const firstClaimant = claimant(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '900',
  '01010101-0101-4101-8101-010101010101',
);
const secondClaimant = claimant(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '950',
  '02020202-0202-4202-8202-020202020202',
);

const diagnostic = (claimants: readonly unknown[]) => ({
  _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
  claimants,
  evidence,
  reason: 'COMPETING_CURRENT_EXACT_PRICES',
  request,
  verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET',
});

const decodeDiagnostic = Schema.decodeUnknownSync(ExactPriceConflictDiagnosticSchema, {
  onExcessProperty: 'error',
});

describe('Issue #764 exact-key Price conflicts acceptance contract', () => {
  it('treats distinct same-key Current truths as conflict for equal or different amounts, including Price 0', () => {
    for (const amounts of [
      ['900', '900'],
      ['900', '950'],
      ['0', '0'],
    ] as const) {
      const decoded = decodeDiagnostic(
        diagnostic([
          {
            ...firstClaimant,
            priceRevision: {
              ...firstClaimant.priceRevision,
              monetaryAmount: { amount: amounts[0], currencyCode: 'CZK' },
            },
          },
          {
            ...secondClaimant,
            priceRevision: {
              ...secondClaimant.priceRevision,
              monetaryAmount: { amount: amounts[1], currencyCode: 'CZK' },
            },
          },
        ]),
      );

      expect(decoded.reason).toBe('COMPETING_CURRENT_EXACT_PRICES');
      expect(decoded.claimants.map(({ priceRevision }) => priceRevision.monetaryAmount.amount)).toEqual(amounts);
    }
  });

  it('collapses neither source evidence nor same-Revision replay into a second claimant', () => {
    const replayWithAnotherSource = {
      ...firstClaimant,
      provenanceRefs: ['03030303-0303-4303-8303-030303030303'],
    };

    expect(() => decodeDiagnostic(diagnostic([firstClaimant, replayWithAnotherSource]))).toThrow();

    expect(
      decodeDiagnostic(
        diagnostic([
          {
            ...firstClaimant,
            provenanceRefs: [...firstClaimant.provenanceRefs, replayWithAnotherSource.provenanceRefs[0]],
          },
          secondClaimant,
        ]),
      ).claimants[0]?.provenanceRefs,
    ).toHaveLength(2);
  });

  it('does not classify historical or future non-overlapping Revisions as Current claimants', () => {
    const historical = {
      ...secondClaimant,
      effectivePeriod: {
        effectiveFrom: secondClaimant.effectivePeriod.effectiveFrom,
        effectiveTo: effectiveAt,
      },
    };
    const future = {
      ...secondClaimant,
      effectivePeriod: {
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveTo: null,
      },
      priceRevision: {
        ...secondClaimant.priceRevision,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
      },
    };

    expect(() => decodeDiagnostic(diagnostic([firstClaimant, historical]))).toThrow();
    expect(() => decodeDiagnostic(diagnostic([firstClaimant, future]))).toThrow();
  });

  it('keeps every canonical key axis distinct and excludes Storefront from the key', () => {
    const otherGroupRef = { ...priceGroupRef, resourceId: '06060606-0606-4606-8606-060606060606' };
    const distinctKeys = [
      {
        ...exactKey,
        catalogSelection: {
          ...selection,
          variantRef: catalogRef('05050505-0505-4505-8505-050505050505', 'commerce.catalog.variant'),
        },
      },
      { ...exactKey, commercialScope: { ...exactKey.commercialScope, marketId: 'SK' } },
      { ...exactKey, commercialScope: { ...exactKey.commercialScope, channelId: 'B2B' } },
      {
        ...exactKey,
        commercialScope: {
          ...exactKey.commercialScope,
          sellingLegalEntityId: '07070707-0707-4707-8707-070707070707',
        },
      },
      {
        ...exactKey,
        unitBasis: {
          quantity: '2',
          unitRef: catalogRef('08080808-0808-4808-8808-080808080808', 'commerce.catalog.product-unit'),
        },
      },
      { ...exactKey, currencyCode: 'EUR' },
      { ...exactKey, priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: otherGroupRef } },
      { ...exactKey, priceGroupSelector: { kind: 'NO_GROUP' } },
    ] as const;

    for (const distinctKey of distinctKeys) {
      const revisedClaimant = {
        ...secondClaimant,
        exactKey: distinctKey,
        priceRevision: {
          ...secondClaimant.priceRevision,
          monetaryAmount: {
            ...secondClaimant.priceRevision.monetaryAmount,
            currencyCode: distinctKey.currencyCode,
          },
        },
      };
      expect(() => decodeDiagnostic(diagnostic([firstClaimant, revisedClaimant]))).toThrow();
    }

    expect(() =>
      decodeDiagnostic({
        ...diagnostic([firstClaimant, secondClaimant]),
        request: { ...request, exactKey: { ...exactKey, storefrontId: 'storefront-a' } },
      }),
    ).toThrow();
  });

  it('preserves exact claimant evidence internally and emits only safe public claimant identity', () => {
    const internal = decodeDiagnostic(diagnostic([firstClaimant, secondClaimant]));
    expect(internal.claimants[0]).toMatchObject({
      effectivePeriod: firstClaimant.effectivePeriod,
      exactKey,
      priceRevision: firstClaimant.priceRevision,
      provenanceRefs: firstClaimant.provenanceRefs,
      scheduleRevision: 1,
    });

    const publicResult = redactExactPriceConflictDiagnostic(internal);
    expect(Schema.is(ExactPriceLookupConflictSchema)(publicResult)).toBe(true);
    expect(publicResult.currentTruthRefs).toHaveLength(2);
    for (const publicClaimant of publicResult.currentTruthRefs) {
      expect(Object.keys(publicClaimant).toSorted()).toEqual(['priceRef', 'revisionId']);
      expect(publicClaimant).not.toHaveProperty('effectivePeriod');
      expect(publicClaimant).not.toHaveProperty('priceRevision');
      expect(publicClaimant).not.toHaveProperty('priceScheduleRevisionId');
      expect(publicClaimant).not.toHaveProperty('provenanceRefs');
      expect(publicClaimant).not.toHaveProperty('scheduleRevision');
    }
  });

  it('keeps native EUR representable without activating it or introducing FX semantics', () => {
    const eurKey = { ...exactKey, currencyCode: 'EUR' } as const;
    const eurClaimant = (value: typeof firstClaimant) => ({
      ...value,
      exactKey: eurKey,
      priceRevision: {
        ...value.priceRevision,
        monetaryAmount: { ...value.priceRevision.monetaryAmount, currencyCode: 'EUR' },
      },
    });
    const decoded = decodeDiagnostic({
      ...diagnostic([eurClaimant(firstClaimant), eurClaimant(secondClaimant)]),
      request: { ...request, exactKey: eurKey },
    });

    expect(decoded.request.exactKey.currencyCode).toBe('EUR');
    expect(decoded.claimants.every(({ priceRevision }) => priceRevision.monetaryAmount.currencyCode === 'EUR')).toBe(
      true,
    );
    expect(JSON.stringify(decoded)).not.toMatch(/exchange|conversion|fxRate|storefront/iu);
  });
});
