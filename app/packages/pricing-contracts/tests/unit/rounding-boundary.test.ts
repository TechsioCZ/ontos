import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PricingPublishedCommercialLineSchema } from '../../src/domain/commercial-total.ts';
import { PRICING_CZK_PUBLICATION_PROFILE } from '../../src/domain/exact-decimal.ts';
import {
  PricingLinePublicationFailedSchema,
  roundPricingExactDecimalHalfUp,
} from '../../src/domain/rounding-boundary.ts';

describe('Pricing line publication contract', () => {
  it('applies CZK HALF_UP exactly once without binary floating point', () => {
    expect(roundPricingExactDecimalHalfUp('33.335', 2)).toBe('33.34');
    expect(roundPricingExactDecimalHalfUp('66.665', 2)).toBe('66.67');
    expect(roundPricingExactDecimalHalfUp('1.004', 2)).toBe('1');
    expect(roundPricingExactDecimalHalfUp('1.005', 2)).toBe('1.01');
    expect(roundPricingExactDecimalHalfUp('0.0065', 2)).toBe('0.01');
    expect(roundPricingExactDecimalHalfUp('0.0007', 2)).toBe('0');
  });

  it('retains already-supported exact values and rejects unsupported precision or carried overflow', () => {
    expect(roundPricingExactDecimalHalfUp('10.01', 2)).toBe('10.01');
    expect(roundPricingExactDecimalHalfUp('10', 2)).toBe('10');
    expect(roundPricingExactDecimalHalfUp('1.001', -1)).toBeUndefined();
    expect(roundPricingExactDecimalHalfUp('1.001', 19)).toBeUndefined();
    expect(roundPricingExactDecimalHalfUp(`${'9'.repeat(58)}.9`, 0)).toBeUndefined();
  });

  it('carries stable occurrence identity and signed adjustment evidence on the reused published-line contract', () => {
    const published = {
      occurrenceId: 'purchase-occurrence-1',
      publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
      publishedLineValue: { amount: '33.34', currencyCode: 'CZK' },
      roundingAdjustment: { amount: '0.005', currencyCode: 'CZK' },
    } as const;
    expect(Schema.decodeSync(PricingPublishedCommercialLineSchema)(published)).toEqual(published);
    expect(
      Schema.decodeSync(PricingPublishedCommercialLineSchema)({
        ...published,
        publishedLineValue: { amount: '66.66', currencyCode: 'CZK' },
        roundingAdjustment: { amount: '-0.005', currencyCode: 'CZK' },
      }),
    ).toMatchObject({ occurrenceId: 'purchase-occurrence-1', roundingAdjustment: { amount: '-0.005' } });
  });

  it('exposes distinct typed profile, precision, currency, raw-negative, overflow, and evidence failures', () => {
    for (const code of [
      'INVALID_INPUT',
      'UNSUPPORTED_PROFILE',
      'UNSUPPORTED_PRECISION',
      'UNSUPPORTED_CURRENCY',
      'CURRENCY_MISMATCH',
      'RAW_NEGATIVE_UNGUARDED',
      'ARITHMETIC_OVERFLOW',
      'EVIDENCE_UNVERIFIABLE',
    ]) {
      const failed = Schema.decodeUnknownSync(PricingLinePublicationFailedSchema)({
        candidateRef: 'purchase-candidate-1',
        failure: { code, message: 'Typed line-publication failure', retryable: false },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
      expect(failed.failure.code).toBe(code);
    }
  });
});
