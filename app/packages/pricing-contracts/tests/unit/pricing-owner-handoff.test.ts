import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingPurchasingLimitsContributionSchema,
  PricingTaxHandoffSchema,
} from '../../src/domain/pricing-owner-handoff.ts';

const eurMoney = (amount: string) => ({ amount, currencyCode: 'EUR' as const });

const breakdown = {
  baseLineTotal: { amount: '900', currencyCode: 'CZK' },
  commercialFeeTotal: { amount: '20', currencyCode: 'CZK' },
  pricingLineRoundingAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
  pricingOwnedDiscountTotal: { amount: '0', currencyCode: 'CZK' },
  promotionAllocationTotal: { amount: '0', currencyCode: 'CZK' },
  zeroFloorAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
} as const;

const pricing = {
  candidateRef: 'pricing-candidate:792',
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'purchase-occurrence:792',
      publishedLineValue: { amount: '920', currencyCode: 'CZK' },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  pricingNetCommercialTotal: { amount: '920', currencyCode: 'CZK' },
} as const;

const exactPurchase = {
  channelId: 'B2C',
  commerceMarketId: 'market-cz',
  lines: [
    {
      catalogSelectionRef: 'catalog-selection:product-and-explicit-variant:792',
      occurrenceId: 'purchase-occurrence:792',
      quantityAndUnitRef: 'catalog-quantity-and-unit:792',
    },
  ],
  resolvedCurrencyCode: 'CZK',
  sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  subjectOrGuestEvidenceRef: 'customer-context:subject-or-guest:792',
  tenantId: 'tenant:792',
} as const;

const limitsContribution = {
  breakdown,
  contractVersion: 'PRICING_PURCHASE_VALUE_CONTRIBUTION_V1',
  exactPurchase,
  excludedComponents: ['DELIVERY', 'TAX'],
  includedComponents: [
    'BASE_LINE_VALUE',
    'PRICING_FEES',
    'PRICING_OWNED_DISCOUNTS',
    'PROMOTION_ALLOCATIONS',
    'ZERO_FLOOR_ADJUSTMENTS',
    'PRICING_LINE_ROUNDING_ADJUSTMENTS',
  ],
  kind: 'PRICING_PURCHASE_VALUE_CONTRIBUTION',
  ownerVerifiableEvidenceRef: 'pricing-material-evidence:792',
  pricing,
} as const;

const taxHandoff = {
  breakdown,
  contractVersion: 'PRICING_PRE_TAX_HANDOFF_V1',
  exactPurchase,
  kind: 'PRICING_PRE_TAX_HANDOFF',
  monetaryBoundary: 'PRE_TAX',
  ownerVerifiableEvidenceRef: 'pricing-material-evidence:793',
  pricing,
  taxDependency: 'NONE',
} as const;

describe('Pricing purchasing-limits owner boundary (#792)', () => {
  it('hands off the complete Pricing contribution once and leaves Delivery and Tax to their owners', () => {
    const decoded = Schema.decodeSync(PricingPurchasingLimitsContributionSchema)(limitsContribution);
    const deliveryOwnerCharge = 80;

    expect(decoded.pricing.pricingNetCommercialTotal.amount).toBe('920');
    expect(decoded.breakdown.commercialFeeTotal.amount).toBe('20');
    expect(Number(decoded.pricing.pricingNetCommercialTotal.amount) + deliveryOwnerCharge).toBe(1000);
    expect(Number(decoded.pricing.pricingNetCommercialTotal.amount) + 20 + deliveryOwnerCharge).toBe(1020);
    expect(decoded.excludedComponents).toEqual(['DELIVERY', 'TAX']);
    expect(decoded).not.toHaveProperty('purchaseValue');
    expect(decoded).not.toHaveProperty('approvalDecision');
  });

  it('rejects a mismatched total, exact occurrence set, currency, or evidence reference', () => {
    const decode = Schema.decodeUnknownSync(PricingPurchasingLimitsContributionSchema);
    expect(() =>
      decode({
        ...limitsContribution,
        pricing: { ...pricing, pricingNetCommercialTotal: { amount: '940', currencyCode: 'CZK' } },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...limitsContribution,
        exactPurchase: {
          ...exactPurchase,
          lines: [{ ...exactPurchase.lines[0], occurrenceId: 'other-occurrence' }],
        },
      }),
    ).toThrow();
    expect(() => decode({ ...limitsContribution, ownerVerifiableEvidenceRef: '' })).toThrow();
  });
});

describe('Pricing Tax owner boundary (#793)', () => {
  it('publishes canonical pre-Tax lines and breakdown without requiring a Tax Decision', () => {
    const decoded = Schema.decodeSync(PricingTaxHandoffSchema)(taxHandoff);
    expect(decoded.taxDependency).toBe('NONE');
    expect(decoded.pricing.monetaryBoundary).toBe('PRE_TAX');
    expect(decoded.pricing.lines[0]?.publishedLineValue.amount).toBe('920');
  });

  it('does not admit Tax, gross normalization, Shipping, or final-payable ownership', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingTaxHandoffSchema, { onExcessProperty: 'error' });
    for (const forbidden of ['taxDecision', 'taxRate', 'grossTotal', 'shippingTotal', 'finalPayable']) {
      expect(() => decodeStrict({ ...taxHandoff, [forbidden]: { amount: '1', currencyCode: 'CZK' } })).toThrow();
    }
  });

  it('keeps the handoff currency-aware without performing FX or activating another Launch currency', () => {
    const eur = {
      ...taxHandoff,
      breakdown: {
        baseLineTotal: eurMoney('900'),
        commercialFeeTotal: eurMoney('20'),
        pricingLineRoundingAdjustmentTotal: eurMoney('0'),
        pricingOwnedDiscountTotal: eurMoney('0'),
        promotionAllocationTotal: eurMoney('0'),
        zeroFloorAdjustmentTotal: eurMoney('0'),
      },
      exactPurchase: { ...exactPurchase, resolvedCurrencyCode: 'EUR' as const },
      pricing: {
        ...pricing,
        currencyCode: 'EUR' as const,
        lines: [
          {
            occurrenceId: pricing.lines[0].occurrenceId,
            publishedLineValue: eurMoney('920'),
          },
        ],
        pricingNetCommercialTotal: eurMoney('920'),
      },
    };
    expect(Schema.decodeSync(PricingTaxHandoffSchema)(eur).pricing.currencyCode).toBe('EUR');
    expect(eur).not.toHaveProperty('exchangeRate');
  });
});
