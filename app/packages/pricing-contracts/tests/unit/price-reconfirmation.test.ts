import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingProposedTermsComparisonRequestSchema,
  PricingProposedTermsComparisonSchema,
  comparePricingProposedTerms,
} from '../../src/domain/price-reconfirmation.ts';
import type { PricingProposedTermsComparisonRequest } from '../../src/domain/price-reconfirmation.ts';

const result = (amount: string, candidateRef: string) => ({
  candidateRef,
  currencyCode: 'CZK' as const,
  lines: [
    {
      occurrenceId: 'purchase-occurrence:795',
      publishedLineValue: { amount, currencyCode: 'CZK' as const },
    },
  ],
  monetaryBoundary: 'PRE_TAX' as const,
  pricingNetCommercialTotal: { amount, currencyCode: 'CZK' as const },
});

const currentTerms = (amount: string, snapshot: string, termsRef: string) => ({
  authority: { kind: 'ORDINARY_CURRENT' as const },
  materialSnapshotId: snapshot,
  result: result(amount, `candidate:${snapshot}`),
  termsRef,
});

const materialChange = {
  _tag: 'MATERIAL_CHANGED' as const,
  currentSnapshotId: 'snapshot:current',
  previousSnapshotId: 'snapshot:previous',
  reasons: ['PRICE_SCHEDULE_BOUNDARY_CROSSED' as const],
};

const comparisonRequest = (previousAmount: string, currentAmount: string) => ({
  assessedAt: '2026-09-29T12:00:00.000Z',
  current: currentTerms(currentAmount, 'snapshot:current', 'terms:current'),
  materialChange,
  previous: currentTerms(previousAmount, 'snapshot:previous', 'terms:previous'),
});

const compare = (request: PricingProposedTermsComparisonRequest) => {
  const decoded = Schema.decodeSync(PricingProposedTermsComparisonRequestSchema)(request);
  return Schema.decodeSync(PricingProposedTermsComparisonSchema)(comparePricingProposedTerms(decoded));
};

describe('Pricing proposed-price reconfirmation boundary (#795)', () => {
  it('requires explicit reconfirmation when proposed Pricing increases', () => {
    expect(compare(comparisonRequest('920', '950'))).toMatchObject({
      changedOccurrenceIds: ['purchase-occurrence:795'],
      direction: 'INCREASED',
      kind: 'PRICING_RECONFIRMATION_REQUIRED',
      reconfirmationRequired: true,
    });
  });

  it('also requires explicit reconfirmation when proposed Pricing decreases', () => {
    expect(compare(comparisonRequest('950', '920'))).toMatchObject({
      changedOccurrenceIds: ['purchase-occurrence:795'],
      direction: 'DECREASED',
      kind: 'PRICING_RECONFIRMATION_REQUIRED',
      reconfirmationRequired: true,
    });
  });

  it('does not hide a material binding change behind an unchanged total', () => {
    expect(compare(comparisonRequest('920', '920'))).toMatchObject({
      direction: 'BINDING_CHANGED',
      kind: 'PRICING_RECONFIRMATION_REQUIRED',
      reconfirmationRequired: true,
    });
  });

  it('accepts unchanged prices only with an owner-classified non-material transition', () => {
    const request = comparisonRequest('920', '920');
    expect(
      compare({
        ...request,
        materialChange: {
          _tag: 'NON_MATERIAL',
          currentSnapshotId: 'snapshot:current',
          previousSnapshotId: 'snapshot:previous',
          reason: 'EXACT_MATERIAL_STATE',
        },
      }),
    ).toMatchObject({ kind: 'PRICING_TERMS_UNCHANGED', reconfirmationRequired: false });
  });

  it('keeps a valid exact Quotation authoritative instead of silently repricing it from ordinary Current', () => {
    const request = comparisonRequest('900', '950');
    expect(
      compare({
        ...request,
        previous: {
          ...request.previous,
          authority: {
            kind: 'VALID_QUOTATION',
            quotationRef: 'quotation:795',
            quotationValidationRef: 'quotation-validation:795',
            validUntil: '2026-09-29T12:05:00.000Z',
          },
        },
      }),
    ).toMatchObject({
      authoritativeQuotationRef: 'quotation:795',
      kind: 'GUARANTEED_TERMS_RETAINED',
      reconfirmationRequired: false,
    });
  });

  it('fails closed when the comparison is unverifiable or the retained Quotation has expired', () => {
    const request = comparisonRequest('920', '950');
    expect(
      compare({
        ...request,
        materialChange: {
          _tag: 'UNVERIFIABLE',
          currentSnapshotId: 'snapshot:current',
          previousSnapshotId: 'snapshot:previous',
          reasons: ['Owner proof unavailable'],
        },
      }),
    ).toMatchObject({ kind: 'PRICING_RECONFIRMATION_UNVERIFIABLE', retryable: true });
    expect(() =>
      compare({
        ...request,
        previous: {
          ...request.previous,
          authority: {
            kind: 'VALID_QUOTATION',
            quotationRef: 'quotation:expired',
            quotationValidationRef: 'quotation-validation:expired',
            validUntil: '2026-09-29T11:59:59.999Z',
          },
        },
      }),
    ).toThrow();
  });
});
