import {
  QuantityTierSelectionFailureSchema,
  QuantityTierSelectionInputSchema,
  QuantityTierSelectionResultSchema,
} from '../../src/domain/quantity-tier.ts';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const quantityBasis = {
  catalogQuantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 5,
  },
  priceUnitBasis: { quantity: '1', unitRef },
};
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const tierVerificationRef = 'commerce.pricing.quantity-tier-set-proof:767';

const selectionInput = (currencyCode: 'CZK' | 'EUR' = 'CZK') => ({
  attempt: {
    evaluatedAt: '2026-09-27T12:00:00.000Z',
    exactPrice: {
      path: { priceGroupSelector: { kind: 'NO_GROUP' }, requiredAbsenceEvidence: [] },
      price: {
        definition: {
          identityKey: {
            catalogSelection: {
              productRef: {
                moduleId: 'commerce.catalog',
                resourceId: '55555555-5555-4555-8555-555555555555',
                resourceType: 'commerce.catalog.product',
                tenantId,
              },
              variantRef,
            },
            commercialScope: {
              channelId: 'B2C',
              marketId: 'cz-launch',
              sellingLegalEntityId: '66666666-6666-4666-8666-666666666666',
            },
            currencyCode,
            priceGroupSelector: { kind: 'NO_GROUP' },
            unitBasis: quantityBasis.priceUnitBasis,
          },
          priceRef,
          revision: {
            effectiveFrom,
            monetaryAmount: { amount: '100', currencyCode },
            monetaryBoundary: 'PRE_TAX',
            revision: 1,
            revisionId: '77777777-7777-4777-8777-777777777777',
          },
        },
        effectivePeriod: { effectiveFrom, effectiveTo: null },
        lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
      },
      scheduleRevision: 1,
    },
    normalizedQuantity: { quantity: '15', quantityBasis },
    tierSetPriceRef: priceRef,
  },
  tierSet: {
    authority: {
      generation: 1,
      observedAt: '2026-09-27T10:00:00.000Z',
      ownerRevision: 'tier-set-r1',
      ownerRootRef: `quantity-tier-set:${priceRef.resourceId}`,
      predicateRef: `price:${priceRef.resourceId}`,
      verificationRef: tierVerificationRef,
    },
    completenessEvidence: {
      nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
      observedAt: '2026-09-27T10:00:00.000Z',
      ownerRevision: 'tier-set-r1',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: `price:${priceRef.resourceId}` },
    },
    currentTiers: [
      {
        definition: {
          identityKey: { priceRef, quantityBasis, thresholdQuantity: '10' },
          revision: {
            effectiveFrom,
            monetaryBoundary: 'PRE_TAX',
            resultingUnitPrice: { amount: '90', currencyCode },
            revision: 1,
            revisionId: '88888888-8888-4888-8888-888888888888',
          },
        },
        effectivePeriod: { effectiveFrom, effectiveTo: null },
        lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
      },
    ],
    factProofs: [
      {
        factRef: 'quantity-tier:10',
        factRevisionRef: '88888888-8888-4888-8888-888888888888',
        verificationRef: tierVerificationRef,
      },
    ],
    priceRef,
  },
});

describe('Pricing Quantity Tier threshold selection #767 contracts', () => {
  it('preserves exact Price, Variant, SLE, Channel, Market, currency, Unit, and basis evidence', () => {
    const decoded = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema)(selectionInput());

    expect(decoded.attempt.exactPrice.price.definition.priceRef).toEqual(priceRef);
    expect(decoded.attempt.exactPrice.price.definition.identityKey).toMatchObject({
      catalogSelection: { variantRef },
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz-launch',
        sellingLegalEntityId: '66666666-6666-4666-8666-666666666666',
      },
      currencyCode: 'CZK',
      unitBasis: quantityBasis.priceUnitBasis,
    });
    expect(decoded.attempt.normalizedQuantity.quantityBasis).toEqual(quantityBasis);
  });

  it('excludes Storefront, implicit conversion, and graduated-band fields', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema, {
      onExcessProperty: 'error',
    });
    expect(() => decode({ ...selectionInput(), storefrontId: 'storefront-prague' })).toThrow();
    expect(() =>
      decode({
        ...selectionInput(),
        exchangeRate: '25',
      }),
    ).toThrow();

    const input = decode(selectionInput());
    const applied = {
      appliesToQuantity: input.attempt.normalizedQuantity,
      bands: [{ quantity: '10', unitPrice: '90' }],
      evidence: {
        decision: { kind: 'HIGHEST_REACHED_THRESHOLD', winningTier: input.tierSet.currentTiers[0] },
        input,
      },
      monetaryBoundary: 'PRE_TAX',
      outcome: 'QUANTITY_TIER_APPLIED',
      resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
    };
    expect(() =>
      Schema.decodeUnknownSync(QuantityTierSelectionResultSchema, {
        onExcessProperty: 'error',
      })(applied),
    ).toThrow();
  });

  it('keeps generalized native-currency contracts without enabling FX or activating another currency', () => {
    const eur = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema)(selectionInput('EUR'));
    expect(eur.attempt.exactPrice.price.definition.identityKey.currencyCode).toBe('EUR');
    expect(eur.tierSet.currentTiers[0]?.definition.revision.resultingUnitPrice.currencyCode).toBe('EUR');

    const decode = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema, {
      onExcessProperty: 'error',
    });
    expect(() => decode({ ...selectionInput('EUR'), fxRate: '25' })).toThrow();
  });

  it('rejects a forged winner that reuses a complete-set revision ID with changed Tier facts', () => {
    const input = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema)(selectionInput());
    const [winner] = input.tierSet.currentTiers;
    if (winner === undefined) {
      throw new Error('expected a complete-set Tier fixture');
    }
    const forgedWinners = [
      {
        ...winner,
        definition: {
          ...winner.definition,
          identityKey: { ...winner.definition.identityKey, thresholdQuantity: '11' },
        },
      },
      {
        ...winner,
        definition: {
          ...winner.definition,
          revision: {
            ...winner.definition.revision,
            resultingUnitPrice: { amount: '89', currencyCode: 'CZK' },
          },
        },
      },
      {
        ...winner,
        definition: {
          ...winner.definition,
          revision: { ...winner.definition.revision, effectiveFrom: '2026-09-02T00:00:00.000Z' },
        },
        effectivePeriod: { ...winner.effectivePeriod, effectiveFrom: '2026-09-02T00:00:00.000Z' },
      },
    ];

    for (const forgedWinner of forgedWinners) {
      expect(() =>
        Schema.decodeUnknownSync(QuantityTierSelectionResultSchema)({
          appliesToQuantity: input.attempt.normalizedQuantity,
          evidence: {
            decision: { kind: 'HIGHEST_REACHED_THRESHOLD', winningTier: forgedWinner },
            input,
          },
          monetaryBoundary: 'PRE_TAX',
          outcome: 'QUANTITY_TIER_APPLIED',
          resultingUnitPrice: forgedWinner.definition.revision.resultingUnitPrice,
        }),
      ).toThrow();
    }
  });

  it('represents unusable Tier sets only as typed failures with no hidden base result', () => {
    const { attempt } = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema)(selectionInput());
    const reasons = [
      'INCOMPLETE_TIER_SET',
      'UNAVAILABLE_TIER_SET',
      'UNVERIFIABLE_TIER_SET',
      'STALE_TIER_SET',
      'PRICE_BINDING_MISMATCH',
      'INCOMPATIBLE_QUANTITY_BASIS',
      'CURRENCY_MISMATCH',
      'AMBIGUOUS_THRESHOLD',
      'CONFLICTING_CURRENT_TIERS',
    ] as const;

    for (const reason of reasons) {
      const decoded = Schema.decodeUnknownSync(QuantityTierSelectionFailureSchema)({
        attempt,
        candidateTierRevisionIds: [],
        outcome: 'QUANTITY_TIER_SELECTION_FAILED',
        reason,
      });
      expect(decoded.outcome).toBe('QUANTITY_TIER_SELECTION_FAILED');
      expect('resultingUnitPrice' in decoded).toBe(false);
    }
  });
});
