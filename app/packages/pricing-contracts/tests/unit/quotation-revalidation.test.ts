import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingQuotationAuthenticityUnverifiableSchema,
  PricingQuotationAuthenticityVerificationEvidenceSchema,
  PricingQuotationBindingRevalidationAssessmentSchema,
  PricingQuotationRevalidationOutcomeSchema,
} from '../../src/domain/quotation.ts';

const quotationRef = 'pricing-quotation:785';

const transitionEvidence = {
  candidateRef: 'purchase-candidate:785',
  materiality: 'NON_MATERIAL',
  originalEvidenceRef: 'customer-context:evidence:old',
  ownerModuleId: 'commerce.customer-context',
  ownerRef: 'customer-context-owner:cz',
  proposedEvidenceRef: 'customer-context:evidence:new',
  quotationRef,
  source: 'OWNING_DOMAIN_ATTESTATION',
  status: 'CONFIRMED',
  tenantId: '11111111-1111-4111-8111-111111111111',
  transitionEvidenceRef: 'customer-context:transition:785',
  transitionEvidenceVersion: '1',
  verifiedAt: '2026-09-28T10:01:00.000Z',
} as const;

describe('Pricing Quotation revalidation contract', () => {
  it('keeps direct matching, owner review, owner acceptance, material mismatch, and outage distinct', () => {
    const assessments = [
      { kind: 'EXACT_MATCH', quotationRef },
      {
        kind: 'OWNER_REVALIDATION_REQUIRED',
        originalEvidenceRef: transitionEvidence.originalEvidenceRef,
        ownerModuleId: transitionEvidence.ownerModuleId,
        ownerRef: transitionEvidence.ownerRef,
        proposedEvidenceRef: transitionEvidence.proposedEvidenceRef,
        quotationRef,
      },
      { kind: 'OWNER_REVALIDATION_ACCEPTED', transitionEvidence },
      { kind: 'MISMATCH', quotationRef, reason: 'AUTHORITY_CONTEXT_CHANGED' },
      {
        kind: 'BINDING_UNVERIFIABLE',
        quotationRef,
        reason: 'OWNER_REVALIDATION_UNAVAILABLE',
        retryable: true,
      },
    ] as const;

    for (const assessment of assessments) {
      expect(Schema.is(PricingQuotationBindingRevalidationAssessmentSchema)(assessment)).toBe(true);
    }
    expect(new Set(assessments.map(({ kind }) => kind)).size).toBe(assessments.length);
  });

  it('records active or historical verification lineage without granting bearer authority', () => {
    const evidence = {
      authenticityRef: 'pricing-authenticity:785',
      authority: 'EVIDENCE_ONLY',
      issuerRef: 'commerce.pricing',
      keyRef: 'pricing-quotation-key',
      keyStatus: 'HISTORICAL',
      keyVersion: '2026-09-01',
      lineageRef: 'pricing-key-lineage:1',
      payloadDigest: 'sha256:quoted-payload',
      proofVersion: '1',
      quotationRef,
      verifiedAt: '2026-09-28T10:01:00.000Z',
    } as const;

    expect(Schema.decodeSync(PricingQuotationAuthenticityVerificationEvidenceSchema)(evidence)).toEqual(evidence);
    expect(
      Schema.is(PricingQuotationAuthenticityVerificationEvidenceSchema)({
        ...evidence,
        authority: 'BEARER',
      }),
    ).toBe(false);
  });

  it('makes only authenticity dependency unavailability retryable', () => {
    expect(
      Schema.is(PricingQuotationAuthenticityUnverifiableSchema)({
        kind: 'AUTHENTICITY_UNVERIFIABLE',
        quotationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingQuotationAuthenticityUnverifiableSchema)({
        kind: 'AUTHENTICITY_UNVERIFIABLE',
        quotationRef,
        reason: 'UNKNOWN_KEY',
        retryable: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingQuotationAuthenticityUnverifiableSchema)({
        kind: 'AUTHENTICITY_UNVERIFIABLE',
        quotationRef,
        reason: 'UNKNOWN_KEY',
        retryable: true,
      }),
    ).toBe(false);
  });

  it('separates expiry, not-yet-valid, trusted-time outage, invalid proof, and fresh-quote requirement', () => {
    const validity = {
      policyEvidence: {
        maximumValidityDurationMilliseconds: 3_600_000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '1',
      },
      validFrom: '2026-09-28T10:00:00.000Z',
      validUntil: '2026-09-28T11:00:00.000Z',
    } as const;
    const outcomes = [
      { evaluatedAt: validity.validUntil, kind: 'EXPIRED', quotationRef, validity },
      {
        evaluatedAt: '2026-09-28T09:59:59.999Z',
        kind: 'NOT_YET_VALID',
        quotationRef,
        validity,
      },
      {
        kind: 'VALIDITY_UNVERIFIABLE',
        quotationRef,
        reason: 'TRUSTED_TIME_UNAVAILABLE',
        retryable: true,
      },
      { kind: 'AUTHENTICITY_INVALID', quotationRef, reason: 'PAYLOAD_TAMPERED', retryable: false },
      {
        kind: 'NEW_QUOTATION_REQUIRED',
        mismatchReason: 'QUANTITY_CHANGED',
        quotationRef,
        retryable: false,
      },
    ] as const;

    for (const outcome of outcomes) {
      expect(Schema.is(PricingQuotationRevalidationOutcomeSchema)(outcome)).toBe(true);
    }
    expect(new Set(outcomes.map(({ kind }) => kind)).size).toBe(outcomes.length);
  });

  it('does not treat Current terms, Tax, Storefront, FX, or Confirmation as revalidation outcomes', () => {
    for (const kind of [
      'CURRENT_PRICING_RESULT',
      'TAX_REVALIDATED',
      'STOREFRONT_REBOUND',
      'FX_CONVERTED',
      'PRICING_COMMITMENT_CONFIRMATION',
    ]) {
      expect(Schema.is(PricingQuotationRevalidationOutcomeSchema)({ kind, quotationRef })).toBe(false);
    }
  });
});
