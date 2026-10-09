import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCommercialTotalBreakdownSchema,
  PricingCommercialTotalFailedSchema,
  PricingCommercialTotalSafeProjectionSchema,
} from '../../src/domain/commercial-total.ts';

const breakdown = {
  baseLineTotal: { amount: '100', currencyCode: 'CZK' },
  commercialFeeTotal: { amount: '5', currencyCode: 'CZK' },
  pricingLineRoundingAdjustmentTotal: { amount: '0.01', currencyCode: 'CZK' },
  pricingOwnedDiscountTotal: { amount: '-10', currencyCode: 'CZK' },
  promotionAllocationTotal: { amount: '-2', currencyCode: 'CZK' },
  zeroFloorAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
} as const;

const projection = {
  candidateRef: 'purchase-candidate-1',
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'purchase-occurrence-1',
      publishedLineValue: { amount: '93.01', currencyCode: 'CZK' },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  pricingNetCommercialTotal: { amount: '93.01', currencyCode: 'CZK' },
} as const;

describe('Pricing commercial-total contract', () => {
  it('reconciles one safe pre-Tax currency to its published lines', () => {
    expect(Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)(projection)).toEqual(projection);
  });

  it('keeps exact sub-cent components while publishing one final rounded line and total', () => {
    const exactBreakdown = {
      baseLineTotal: { amount: '33.335', currencyCode: 'CZK' },
      commercialFeeTotal: { amount: '0', currencyCode: 'CZK' },
      pricingLineRoundingAdjustmentTotal: { amount: '0.005', currencyCode: 'CZK' },
      pricingOwnedDiscountTotal: { amount: '0', currencyCode: 'CZK' },
      promotionAllocationTotal: { amount: '0', currencyCode: 'CZK' },
      zeroFloorAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
    } as const;
    const exactProjection = {
      ...projection,
      lines: [
        {
          occurrenceId: 'purchase-occurrence-1',
          publishedLineValue: { amount: '33.34', currencyCode: 'CZK' },
        },
      ],
      pricingNetCommercialTotal: { amount: '33.34', currencyCode: 'CZK' },
    } as const;

    expect(Schema.decodeSync(PricingCommercialTotalBreakdownSchema)(exactBreakdown)).toEqual(exactBreakdown);
    expect(Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)(exactProjection)).toEqual(exactProjection);
  });

  it('rejects a downstream net total that differs from the published-line sum', () => {
    expect(() =>
      Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)({
        ...projection,
        pricingNetCommercialTotal: { amount: '98.01', currencyCode: 'CZK' },
      }),
    ).toThrow();
  });

  it('keeps the contract currency-aware without activating another Launch currency or adding FX', () => {
    const eurProjection = {
      ...projection,
      currencyCode: 'EUR',
      lines: [
        {
          occurrenceId: 'purchase-occurrence-1',
          publishedLineValue: { amount: '93.01', currencyCode: 'EUR' },
        },
      ],
      pricingNetCommercialTotal: { amount: '93.01', currencyCode: 'EUR' },
    } as const;
    expect(Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)(eurProjection)).toEqual(eurProjection);
    expect(eurProjection).not.toHaveProperty('exchangeRate');
    expect(() =>
      Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)({
        ...projection,
        lines: [
          {
            occurrenceId: 'purchase-occurrence-1',
            publishedLineValue: { amount: '93.001', currencyCode: 'CZK' },
          },
        ],
        pricingNetCommercialTotal: { amount: '93.001', currencyCode: 'CZK' },
      }),
    ).toThrow();
  });

  it('excludes Shipping, Tax, gross, final-payable, and intermediate discountable basis from the safe projection', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingCommercialTotalSafeProjectionSchema, {
      onExcessProperty: 'error',
    });
    for (const forbidden of [
      'breakdown',
      'shippingTotal',
      'deliveryAllocation',
      'taxTotal',
      'grossTotal',
      'finalPayable',
      'discountableLineBasis',
    ]) {
      expect(() => decodeStrict({ ...projection, [forbidden]: { amount: '1', currencyCode: 'CZK' } })).toThrow();
    }
  });

  it('enforces component signs and exposes typed invalid, conflict, precision, currency, and evidence failures', () => {
    expect(() =>
      Schema.decodeSync(PricingCommercialTotalBreakdownSchema)({
        ...breakdown,
        commercialFeeTotal: { amount: '-1', currencyCode: 'CZK' },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PricingCommercialTotalBreakdownSchema)({
        ...breakdown,
        promotionAllocationTotal: { amount: '1', currencyCode: 'CZK' },
      }),
    ).toThrow();

    for (const code of [
      'INVALID_INPUT',
      'DECISION_CONFLICT',
      'PRECISION_MISMATCH',
      'CURRENCY_MISMATCH',
      'EVIDENCE_UNVERIFIABLE',
    ]) {
      expect(
        Schema.decodeUnknownSync(PricingCommercialTotalFailedSchema)({
          candidateRef: 'purchase-candidate-1',
          failure: { code, message: 'Typed commercial-total failure', retryable: false },
          outcome: 'COMMERCIAL_TOTAL_FAILED',
        }).failure.code,
      ).toBe(code);
    }
  });
});
