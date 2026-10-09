import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCommitmentConfirmationAuthenticityProofSchema,
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationExpiredSchema,
  PricingCommitmentConfirmationNotYetValidSchema,
  PricingCommitmentConfirmationReplacementBundleRequiredSchema,
  PricingCommitmentConfirmationSourceInvalidSchema,
  PricingCommitmentConfirmationSourceUnverifiableSchema,
  PricingCommitmentConfirmationValiditySchema,
  PricingCommitmentConfirmationValidityUnverifiableSchema,
} from '../../src/domain/commitment-confirmation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const purchase = {
  candidateRef: 'purchase-candidate:788',
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz-b2c',
    sellingLegalEntityId: '22222222-2222-4222-8222-222222222222',
  },
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'purchase-occurrence:788',
      quantity: {
        amount: '1',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '33333333-3333-4333-8333-333333333333',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      },
      selection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: '44444444-4444-4444-8444-444444444444',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  subject: {
    guestEvidenceRef: 'guest-evidence:788',
    guestSessionRef: 'guest-session:788',
    kind: 'GUEST',
    purchaseContext: { contextRef: 'purchase-context:788', contextRevision: '1' },
  },
  tenantId,
} as const;

const binding = {
  attemptRef: 'order-commitment-attempt:788',
  decisionBundleHash: 'sha256:bundle-788',
  decisionBundleRef: 'order-decision-bundle:788',
  decisionBundleVersion: '1',
  purchase,
} as const;

describe('Pricing Commitment Confirmation public contract', () => {
  it('binds one exact Attempt, unchanged Bundle, purchase occurrences, Variant, Market, currency, and Guest', () => {
    expect(Schema.decodeSync(PricingCommitmentConfirmationBindingSchema)(binding)).toEqual(binding);
  });

  it('keeps the proof outside the Bundle and excludes Storefront, Tax, and final-payable state', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingCommitmentConfirmationBindingSchema, {
      onExcessProperty: 'error',
    });
    for (const forbidden of ['confirmationRef', 'storefrontId', 'taxTotal', 'finalPayable']) {
      expect(() => decodeStrict({ ...binding, [forbidden]: 'forbidden' })).toThrow();
    }
  });

  it('preserves a generalized currency binding without activating it as a Launch guarantee', () => {
    expect(
      Schema.is(PricingCommitmentConfirmationBindingSchema)({
        ...binding,
        purchase: { ...purchase, currencyCode: 'EUR' },
      }),
    ).toBe(true);
  });

  it('accepts only non-empty Confirmation intervals no longer than 30 seconds', () => {
    const issuedAt = '2026-09-28T12:00:00.000Z';
    expect(
      Schema.is(PricingCommitmentConfirmationValiditySchema)({
        expiresAt: '2026-09-28T12:00:30.000Z',
        issuedAt,
      }),
    ).toBe(true);
    expect(Schema.is(PricingCommitmentConfirmationValiditySchema)({ expiresAt: issuedAt, issuedAt })).toBe(false);
    expect(
      Schema.is(PricingCommitmentConfirmationValiditySchema)({
        expiresAt: '2026-09-28T12:00:30.001Z',
        issuedAt,
      }),
    ).toBe(false);
  });

  it('retains independent owner proof identity without making it a bearer grant', () => {
    const proof = {
      authority: 'EVIDENCE_ONLY',
      issuerRef: 'commerce.pricing',
      keyRef: 'pricing-key:1',
      keyVersion: '1',
      lineageRef: 'pricing-key-lineage:1',
      payloadDigest: 'sha256:confirmation-payload',
      proofRef: 'pricing-confirmation-proof:1',
      proofVersion: '1',
    } as const;
    expect(Schema.decodeSync(PricingCommitmentConfirmationAuthenticityProofSchema)(proof)).toEqual(proof);
    expect(() =>
      Schema.decodeUnknownSync(PricingCommitmentConfirmationAuthenticityProofSchema, {
        onExcessProperty: 'error',
      })({ ...proof, bearerToken: 'not-authority' }),
    ).toThrow();
  });

  it('distinguishes changed binding, replacement Bundle, source invalidity, and source unavailability', () => {
    expect(
      Schema.is(PricingCommitmentConfirmationBindingMismatchSchema)({
        _tag: 'BINDING_MISMATCH',
        reason: 'BUNDLE_CHANGED',
        retryable: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationBindingMismatchSchema)({
        _tag: 'BINDING_MISMATCH',
        reason: 'ATTEMPT_NOT_FOUND',
        retryable: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationReplacementBundleRequiredSchema)({
        _tag: 'REPLACEMENT_BUNDLE_REQUIRED',
        reason: 'TERMS_CHANGED',
        retryable: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationSourceInvalidSchema)({
        _tag: 'SOURCE_INVALID',
        reason: 'Quotation expired',
        retryable: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationSourceUnverifiableSchema)({
        _tag: 'SOURCE_UNVERIFIABLE',
        reason: 'Quotation owner unavailable',
        retryable: true,
      }),
    ).toBe(true);
  });

  it('models the half-open verification boundary without treating mismatch as revocation', () => {
    expect(
      Schema.is(PricingCommitmentConfirmationNotYetValidSchema)({
        _tag: 'NOT_YET_VALID',
        confirmationRef: 'confirmation:788',
        evaluatedAt: '2026-09-28T11:59:59.999Z',
        issuedAt: '2026-09-28T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationExpiredSchema)({
        _tag: 'EXPIRED',
        confirmationRef: 'confirmation:788',
        evaluatedAt: '2026-09-28T12:00:30.000Z',
        expiresAt: '2026-09-28T12:00:30.000Z',
      }),
    ).toBe(true);
  });

  it('keeps trusted-time and proof unavailability as distinct retryable outcomes', () => {
    expect(
      Schema.is(PricingCommitmentConfirmationValidityUnverifiableSchema)({
        _tag: 'VALIDITY_UNVERIFIABLE',
        confirmationRef: 'confirmation:788',
        reason: 'TRUSTED_TIME_UNAVAILABLE',
        retryable: true,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingCommitmentConfirmationAuthenticityUnverifiableSchema)({
        _tag: 'AUTHENTICITY_UNVERIFIABLE',
        confirmationRef: 'confirmation:788',
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      }),
    ).toBe(true);
  });
});
