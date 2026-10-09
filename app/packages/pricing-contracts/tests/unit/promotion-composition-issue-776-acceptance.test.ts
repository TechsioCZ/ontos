import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingPromotionCompositionFailedSchema,
  PricingPromotionCompositionReadySchema,
} from '@app/pricing-contracts/domain/promotion-composition';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const selection = (suffix: 'a' | 'b') => ({
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: suffix === 'a' ? '22222222-2222-4222-8222-222222222222' : '22222222-2222-4222-8222-222222222223',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: suffix === 'a' ? '33333333-3333-4333-8333-333333333333' : '33333333-3333-4333-8333-333333333334',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
});
const decisionLine = (occurrenceId: 'line-a' | 'line-b', suffix: 'a' | 'b') => {
  const catalogSelection = selection(suffix);
  return {
    catalog: {
      completeness: {
        observedAt: operationTime,
        ownerRevision: `catalog-quantity:776:${suffix}`,
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog-quantity:776:${suffix}` },
      },
      divisible: false,
      equivalentSelectionKey: `catalog-selection:776:${suffix}`,
      evidence: {
        assessedAt: operationTime,
        basis: [
          { role: 'PRODUCT' as const, source: { resourceRef: catalogSelection.productRef, revision: 1 } },
          { role: 'VARIANT' as const, source: { resourceRef: catalogSelection.variantRef, revision: 2 } },
          {
            provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
            role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
            source: { resourceRef: catalogSelection.productRef, revision: 1 },
          },
        ],
        membership: {
          attestationId:
            suffix === 'a' ? '66666666-6666-4666-8666-666666666666' : '66666666-6666-4666-8666-666666666667',
          observedAt: operationTime,
          productRef: catalogSelection.productRef,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
          variant: { resourceRef: catalogSelection.variantRef, revision: 2 },
        },
        purpose: 'PRICING' as const,
        selection: catalogSelection,
        status: 'VALID' as const,
      },
      hierarchyRevision: `catalog-hierarchy:776:${suffix}`,
      ownerRevision: `catalog-quantity:776:${suffix}`,
      quantity: {
        changed: false,
        notice: null,
        requested: '1',
        resulting: '1',
        rounding: 'HALF_UP' as const,
        status: 'VALID' as const,
        step: '1',
        targetId: catalogSelection.variantRef.resourceId,
        tenantId,
        unitId: unitRef.resourceId,
        unitRuleRevision: 7,
      },
      quantityBasis: {
        targetDivisibilityRevision: 3,
        targetRef: catalogSelection.variantRef,
        unitRef,
        unitRuleRevision: 7,
      },
      selection: catalogSelection,
      status: 'READY' as const,
      unitRef,
    },
    occurrenceId,
    pricingBasis: { quantity: '1', unitRef },
  };
};
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK',
  lines: [decisionLine('line-a', 'a'), decisionLine('line-b', 'b')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:776',
      decisionRevision: 'purchase-access-decision-r776',
    },
    actor: {
      guestEvidenceRef: 'guest-context:776',
      guestSessionRef: 'guest-session:776',
      kind: 'GUEST',
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:776',
      decisionRevision: 'purchase-commercial-settings-r776',
    },
    contextRef: 'purchase-776',
    contextRevision: 'purchase-r776',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:776',
      resolutionRevision: 'purchase-currency-resolution-r776',
    },
    subject: {
      guestEvidenceRef: 'guest-context:776',
      guestSessionRef: 'guest-session:776',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const allocation = (occurrenceId: 'line-a' | 'line-b', suffix: 'a' | 'b', amount: string) => ({
  amount: money(amount),
  catalogSelection: selection(suffix),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const ownerEvidence = {
  completenessEvidence: {
    nextApplicabilityBoundary: '2026-09-28T08:01:00.000Z',
    observedAt: operationTime,
    ownerRevision: 'promotion-r776',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'promotion-predicate:776' },
  },
  currentness: {
    evaluatedAt: operationTime,
    observedAt: operationTime,
    revalidatedAt: operationTime,
    status: 'CURRENT' as const,
  },
  exactPredicateRef: 'promotion-predicate:776',
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion-r776',
  provenanceRef: 'promotion-proof:776',
};
const subjectEvidence = {
  evidenceRef: 'subject-proof:776',
  observedAt: operationTime,
  ownerModuleId: 'commerce.customer-context',
  ownerRevision: 'subject-r776',
  provenanceRef: 'subject-provenance:776',
  revalidatedAt: operationTime,
  subject: { guestEvidenceRef: 'guest-context:776', kind: 'GUEST' as const, tenantId },
};
const ready = {
  candidateRef: 'pricing-candidate:776',
  completedPricingAllocationRefs: ['pricing-composition:776', 'whole-purchase-allocation:776'],
  currentnessEvidence: {
    applicationRequestRef: 'voucher-request:776',
    candidateRef: 'pricing-candidate:776',
    currencySupport: {
      currencyCode: 'CZK' as const,
      evidenceRef: 'currency-support-proof:776',
      observedAt: operationTime,
      ownerRevision: 'currency-support-r776',
      status: 'SUPPORTED_CURRENT' as const,
      tenantId,
    },
    exactPredicateRef: 'promotion-predicate:776',
    ownerEvidence,
    pricingCompositionRef: 'pricing-composition:776',
    pricingCompositionRevision: 'pricing-composition-r776',
    subjectEvidence,
  },
  decision,
  lines: [
    {
      catalogSelection: selection('a'),
      occurrenceId: 'line-a',
      prePromotionValue: money('800'),
      promotionAllocation: allocation('line-a', 'a', '-80'),
      rawPreTaxValue: money('720'),
      recipientKind: 'MERCHANDISE' as const,
    },
    {
      catalogSelection: selection('b'),
      occurrenceId: 'line-b',
      prePromotionValue: money('200'),
      promotionAllocation: allocation('line-b', 'b', '-20'),
      rawPreTaxValue: money('180'),
      recipientKind: 'MERCHANDISE' as const,
    },
  ],
  outcome: 'PROMOTION_COMPOSITION_READY' as const,
  promotion: {
    acceptedRequest: {
      applicationRequestRef: 'voucher-request:776',
      candidateRef: 'pricing-candidate:776',
      exactPredicateRef: 'promotion-predicate:776',
      subjectEvidence,
    },
    allocations: [allocation('line-a', 'a', '-80'), allocation('line-b', 'b', '-20')],
    applicationIdentity: {
      applicationKind: 'PROMOTION_APPLICATION' as const,
      applicationRef: 'voucher-application:776',
      applicationRevision: 'voucher-application-r776',
      originalApplicationRef: 'voucher-request:776',
    },
    contribution: money('-100'),
    outcome: 'PROMOTION_APPLIED' as const,
    ownerDecisionRevision: 'promotion-r776',
    ownerEvidence,
    shippingAllocations: [],
    target: { kind: 'MERCHANDISE_ONLY' as const, occurrenceIds: ['line-a', 'line-b'] },
  },
  stage: 'AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION' as const,
};

const isReady = Schema.is(PricingPromotionCompositionReadySchema);

describe('issue #776 Promotion composition result contract', () => {
  it('retains exact original recipients, post-Pricing basis, once-only owner allocations, and complete Current evidence', () => {
    expect(isReady(ready)).toBe(true);
    const decoded = Schema.decodeSync(PricingPromotionCompositionReadySchema)(ready);
    expect(decoded.lines.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-a', 'line-b']);
    expect(decoded.lines.map(({ prePromotionValue }) => prePromotionValue.amount)).toEqual(['800', '200']);
    expect(decoded.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);
    expect(decoded.currentnessEvidence).toEqual(ready.currentnessEvidence);
  });

  it('rejects duplicate deductions, changed recipients, contribution mismatch, implicit Shipping, and non-CZK mixing', () => {
    expect(
      isReady({
        ...ready,
        lines: [{ ...ready.lines[0], rawPreTaxValue: money('640') }, ready.lines[1]],
      }),
    ).toBe(false);
    expect(
      isReady({
        ...ready,
        lines: [ready.lines[0], { ...ready.lines[1], occurrenceId: 'line-a' }],
      }),
    ).toBe(false);
    expect(
      isReady({
        ...ready,
        promotion: { ...ready.promotion, contribution: money('-101') },
      }),
    ).toBe(false);
    expect(
      isReady({
        ...ready,
        promotion: {
          ...ready.promotion,
          shippingAllocations: [
            { amount: money('-10'), deliveryComponentRef: 'delivery-component:776', recipientKind: 'SHIPPING' },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isReady({
        ...ready,
        lines: [ready.lines[0], { ...ready.lines[1], rawPreTaxValue: { amount: '180', currencyCode: 'EUR' } }],
      }),
    ).toBe(false);
  });

  it('rejects zero/non-positive applied Voucher basis instead of clamping, floor-repairing, or silently dropping it', () => {
    expect(
      isReady({
        ...ready,
        lines: ready.lines.map((line) => ({
          ...line,
          prePromotionValue: money('0'),
          rawPreTaxValue: money('0'),
        })),
      }),
    ).toBe(false);
  });

  it('rejects substituting another actual subject behind otherwise matching request evidence', () => {
    expect(
      isReady({
        ...ready,
        promotion: {
          ...ready.promotion,
          acceptedRequest: {
            ...ready.promotion.acceptedRequest,
            subjectEvidence: {
              ...subjectEvidence,
              subject: { guestEvidenceRef: 'guest-context:other', kind: 'GUEST' as const, tenantId },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects a revision-A published application paired with revision-B currentness', () => {
    const revisionA = {
      ...ownerEvidence,
      completenessEvidence: {
        ...ownerEvidence.completenessEvidence,
        ownerRevision: 'promotion-r776-a',
      },
      ownerRevision: 'promotion-r776-a',
      provenanceRef: 'promotion-proof:776:a',
    };
    expect(
      isReady({
        ...ready,
        promotion: {
          ...ready.promotion,
          ownerDecisionRevision: 'promotion-r776-a',
          ownerEvidence: revisionA,
        },
      }),
    ).toBe(false);
  });

  it('keeps typed failure retryability exact and the parked path non-retryable', () => {
    expect(
      Schema.is(PricingPromotionCompositionFailedSchema)({
        candidateRef: 'pricing-candidate:776',
        failure: { reason: 'owner unavailable', retryable: true, type: 'OWNER_UNAVAILABLE' },
        outcome: 'PROMOTION_COMPOSITION_FAILED',
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingPromotionCompositionFailedSchema)({
        candidateRef: 'pricing-candidate:776',
        failure: {
          reason: 'owner decision required',
          retryable: false,
          type: 'ZERO_OR_NON_POSITIVE_ELIGIBLE_BASIS_PARKED',
        },
        outcome: 'PROMOTION_COMPOSITION_FAILED',
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingPromotionCompositionFailedSchema)({
        candidateRef: 'pricing-candidate:776',
        failure: {
          reason: 'owner decision required',
          retryable: true,
          type: 'ZERO_OR_NON_POSITIVE_ELIGIBLE_BASIS_PARKED',
        },
        outcome: 'PROMOTION_COMPOSITION_FAILED',
      }),
    ).toBe(false);
  });
});
