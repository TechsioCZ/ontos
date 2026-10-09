import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingQuotationValidityEvaluationSchema,
  PricingQuotationValiditySchema,
} from '../../src/domain/quotation.ts';

const validity = {
  policyEvidence: {
    maximumValidityDurationMilliseconds: 86_400_000,
    policyRef: 'pricing-quotation-validity:launch',
    policyVersion: '2026-09-28',
  },
  validFrom: '2026-09-28T08:00:00.000Z',
  validUntil: '2026-09-28T09:00:00.000Z',
} as const;

describe('Pricing Quotation validity contract', () => {
  it('requires a non-empty half-open interval within immutable versioned policy evidence', () => {
    expect(Schema.decodeSync(PricingQuotationValiditySchema)(validity)).toEqual(validity);
    expect(
      Schema.is(PricingQuotationValiditySchema)({
        ...validity,
        validUntil: validity.validFrom,
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationValiditySchema)({
        ...validity,
        validFrom: validity.validUntil,
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationValiditySchema)({
        ...validity,
        policyEvidence: {
          ...validity.policyEvidence,
          maximumValidityDurationMilliseconds: 3_599_999,
        },
      }),
    ).toBe(false);
  });

  it('does not confuse the quotation policy with the separate 30-second Confirmation lifetime', () => {
    expect(
      Schema.is(PricingQuotationValiditySchema)({
        ...validity,
        policyEvidence: {
          ...validity.policyEvidence,
          maximumValidityDurationMilliseconds: 30_001,
        },
        validUntil: '2026-09-28T08:00:30.001Z',
      }),
    ).toBe(true);
  });

  it('treats validFrom as inclusive and validUntil as exclusive', () => {
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'VALID',
        evaluatedAt: validity.validFrom,
        quotationRef: 'pricing-quotation:784',
        validity,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'VALID',
        evaluatedAt: '2026-09-28T08:59:59.999Z',
        quotationRef: 'pricing-quotation:784',
        validity,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'VALID',
        evaluatedAt: validity.validUntil,
        quotationRef: 'pricing-quotation:784',
        validity,
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'EXPIRED',
        evaluatedAt: validity.validUntil,
        quotationRef: 'pricing-quotation:784',
        validity,
      }),
    ).toBe(true);
  });

  it('keeps not-yet-valid, expired, and trusted-time unverifiable outcomes distinct', () => {
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'INVALID',
        evaluatedAt: '2026-09-28T07:59:59.999Z',
        quotationRef: 'pricing-quotation:784',
        reason: 'NOT_YET_VALID',
        validity,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'EXPIRED',
        evaluatedAt: '2026-09-28T07:59:59.999Z',
        quotationRef: 'pricing-quotation:784',
        validity,
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationValidityEvaluationSchema)({
        _tag: 'UNVERIFIABLE',
        quotationRef: 'pricing-quotation:784',
        reason: 'TRUSTED_TIME_UNAVAILABLE',
        retryable: true,
        validity,
      }),
    ).toBe(true);
  });

  it('does not admit revocation, mutation, browser-time, Tax, FX, or Commitment fields', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingQuotationValiditySchema, { onExcessProperty: 'error' });
    for (const forbiddenField of [
      'revokedAt',
      'extendedUntil',
      'browserTime',
      'taxRevision',
      'fxRate',
      'confirmationExpiresAt',
    ]) {
      expect(() => decodeStrict({ ...validity, [forbiddenField]: '2026-09-28T09:00:00.000Z' })).toThrow();
    }
  });
});
