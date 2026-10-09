import { PricingDecisionSchema } from '@app/pricing-contracts';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PromotionContributionAppliedSchema,
  PromotionContributionConflictSchema,
  PromotionContributionInvalidSchema,
  PromotionContributionParkedSchema,
  PromotionContributionRequestSchema,
  PromotionContributionUnavailableSchema,
  PromotionContributionUnverifiableSchema,
} from '@app/pricing-contracts/domain/promotion-contribution';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const observedAt = '2026-09-28T08:00:01.000Z';
const revalidatedAt = '2026-09-28T08:00:02.000Z';
const sellingLegalEntityId = '55555555-5555-4555-8555-555555555555';
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
const line = (occurrenceId: 'line-a' | 'line-b', suffix: 'a' | 'b') => {
  const catalogSelection = selection(suffix);
  return {
    catalog: {
      completeness: {
        observedAt: operationTime,
        ownerRevision: `catalog-quantity:775:${suffix}`,
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog-quantity:775:${suffix}` },
      },
      divisible: false,
      equivalentSelectionKey: `catalog-selection:775:${suffix}`,
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
      hierarchyRevision: `catalog-hierarchy:775:${suffix}`,
      ownerRevision: `catalog-quantity:775:${suffix}`,
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
  commercialScope: { channelId: 'B2C', marketId: 'market-cz', sellingLegalEntityId },
  currencyCode: 'CZK',
  lines: [line('line-a', 'a'), line('line-b', 'b')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:775',
      decisionRevision: 'purchase-access-decision-r775',
    },
    actor: {
      guestEvidenceRef: 'commerce-subject:guest-775',
      guestSessionRef: 'guest-session:775',
      kind: 'GUEST',
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:775',
      decisionRevision: 'purchase-commercial-settings-r775',
    },
    contextRef: 'purchase-775',
    contextRevision: 'purchase-r775',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:775',
      resolutionRevision: 'purchase-currency-resolution-r775',
    },
    subject: {
      guestEvidenceRef: 'commerce-subject:guest-775',
      guestSessionRef: 'guest-session:775',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const prePromotionBasis = {
  completedPricingAllocationRefs: ['pricing-line-discounts:775', 'pricing-whole-purchase:775'],
  currencyCode: 'CZK' as const,
  lines: [
    { amount: money('800'), catalogSelection: selection('a'), occurrenceId: 'line-a' },
    { amount: money('200'), catalogSelection: selection('b'), occurrenceId: 'line-b' },
  ],
  monetaryBoundary: 'PRE_TAX' as const,
  pricingCompositionRef: 'pricing-composition:775',
  pricingCompositionRevision: 'pricing-composition-r775',
  stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS' as const,
};
const subjectEvidence = {
  evidenceRef: 'commerce-subject:guest-775',
  observedAt: operationTime,
  ownerModuleId: 'commerce.customer-context',
  ownerRevision: 'commerce-subject-r775',
  provenanceRef: 'commerce-subject-proof:775',
  revalidatedAt: operationTime,
  subject: { guestEvidenceRef: 'guest-session:775', kind: 'GUEST' as const, tenantId },
};
const request = {
  applicationRequestRef: 'voucher-request:775',
  candidate: { candidateRef: 'pricing-candidate:775', decision },
  currencyCompatibility: {
    currencyCode: 'CZK' as const,
    evidenceRef: 'pricing-currency-support:775',
    observedAt: operationTime,
    ownerRevision: 'pricing-currency-support-r775',
    status: 'SUPPORTED_CURRENT' as const,
    tenantId,
  },
  exactPredicateRef: 'promotion-contribution:pricing-candidate:775',
  prePromotionBasis,
  subjectEvidence,
};
const applicationIdentity = {
  applicationKind: 'PROMOTION_APPLICATION' as const,
  applicationRef: 'voucher-application:775',
  applicationRevision: 'voucher-application-r775',
  originalApplicationRef: request.applicationRequestRef,
};
const ownerEvidence = {
  completenessEvidence: {
    observedAt,
    ownerRevision: 'promotion-current-r775',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'promotion-contribution:pricing-candidate:775' },
  },
  currentness: { evaluatedAt: operationTime, observedAt, revalidatedAt, status: 'CURRENT' as const },
  exactPredicateRef: request.exactPredicateRef,
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion-current-r775',
  provenanceRef: 'promotion-proof:775',
};
const allocations = [
  {
    amount: money('-80'),
    catalogSelection: selection('a'),
    occurrenceId: 'line-a',
    recipientKind: 'MERCHANDISE' as const,
  },
  {
    amount: money('-20'),
    catalogSelection: selection('b'),
    occurrenceId: 'line-b',
    recipientKind: 'MERCHANDISE' as const,
  },
];
const applied = {
  _tag: 'PROMOTION_CONTRIBUTION_APPLIED' as const,
  allocations,
  applicationIdentity,
  contribution: money('-100'),
  ownerEvidence,
  request,
  target: { kind: 'MERCHANDISE_ONLY' as const, occurrenceIds: ['line-a', 'line-b'] },
};

const decodeRequestClosed = Schema.decodeUnknownSync(PromotionContributionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeApplied = Schema.decodeUnknownSync(PromotionContributionAppliedSchema, { onExcessProperty: 'error' });

describe('issue #775 Promotion contribution owner contract', () => {
  it('preserves exact application, Guest, candidate context, original Variant lines, and post-Pricing-discount basis', () => {
    const decoded = decodeApplied(applied);

    expect(decoded.applicationIdentity).toEqual(applicationIdentity);
    expect(decoded.request.candidate.decision.commercialScope).toEqual({
      channelId: 'B2C',
      marketId: 'market-cz',
      sellingLegalEntityId,
    });
    expect(decoded.request.subjectEvidence.subject).toEqual(subjectEvidence.subject);
    expect(decoded.request.prePromotionBasis.stage).toBe('AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS');
    expect(decoded.request.prePromotionBasis.completedPricingAllocationRefs).toEqual([
      'pricing-line-discounts:775',
      'pricing-whole-purchase:775',
    ]);
    expect(decoded.request.prePromotionBasis.lines.map(({ amount }) => amount.amount)).toEqual(['800', '200']);
    expect(decoded.allocations.map(({ amount }) => amount.amount)).toEqual(['-80', '-20']);
    expect(decoded.contribution.amount).toBe('-100');
  });

  it('rejects changed application identity, wrong sum, duplicate recipients, positive allocation fragments, and altered Variant lines', () => {
    expect(() =>
      decodeApplied({
        ...applied,
        applicationIdentity: { ...applicationIdentity, originalApplicationRef: 'another-voucher-request' },
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [{ ...allocations[0], amount: money('-79') }, allocations[1]],
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [allocations[0], { ...allocations[0], amount: money('-20') }],
        target: { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a', 'line-a'] },
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [
          { ...allocations[0], amount: money('10') },
          { ...allocations[1], amount: money('-110') },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [{ ...allocations[0], catalogSelection: selection('b') }, allocations[1]],
      }),
    ).toThrow();
  });

  it('excludes Shipping by default and accepts it only as an explicit Delivery-owned component target', () => {
    const shippingAllocation = {
      amount: money('-10'),
      deliveryComponentRef: 'delivery-component:775',
      recipientKind: 'SHIPPING' as const,
    };
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [{ ...allocations[0], amount: money('-70') }, allocations[1], shippingAllocation],
      }),
    ).toThrow();

    const explicitShipping = decodeApplied({
      ...applied,
      allocations: [{ ...allocations[0], amount: money('-70') }, allocations[1], shippingAllocation],
      target: {
        kind: 'BASKET_WITH_EXPLICIT_SHIPPING',
        occurrenceIds: ['line-a', 'line-b'],
        shippingComponentRefs: ['delivery-component:775'],
      },
    });
    expect(explicitShipping.allocations.at(-1)).toEqual(shippingAllocation);
  });

  it('fails closed on Tenant, occurrence, Variant, currency, owner revision, and currentness tampering without FX', () => {
    expect(decodeRequestClosed(request).currencyCompatibility.tenantId).toBe(tenantId);
    expect(() =>
      decodeRequestClosed({
        ...request,
        currencyCompatibility: {
          ...request.currencyCompatibility,
          tenantId: '99999999-9999-4999-8999-999999999999',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRequestClosed({
        ...request,
        subjectEvidence: {
          ...subjectEvidence,
          subject: { ...subjectEvidence.subject, tenantId: '99999999-9999-4999-8999-999999999999' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRequestClosed({
        ...request,
        prePromotionBasis: { ...prePromotionBasis, lines: [prePromotionBasis.lines[0]] },
      }),
    ).toThrow();
    expect(() =>
      decodeRequestClosed({
        ...request,
        prePromotionBasis: {
          ...prePromotionBasis,
          lines: [{ ...prePromotionBasis.lines[0], catalogSelection: selection('b') }, prePromotionBasis.lines[1]],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        contribution: { amount: '-100', currencyCode: 'EUR' },
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        ownerEvidence: {
          ...ownerEvidence,
          completenessEvidence: { ...ownerEvidence.completenessEvidence, ownerRevision: 'tampered-r775' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        ownerEvidence: {
          ...ownerEvidence,
          currentness: { ...ownerEvidence.currentness, revalidatedAt: operationTime },
        },
      }),
    ).toThrow();
  });

  it('keeps Storefront and raw Promotion rules outside the owner request', () => {
    expect(() => decodeRequestClosed({ ...request, storefrontId: 'storefront-a' })).toThrow();
    expect(() => decodeRequestClosed({ ...request, appId: 'storefront-b' })).toThrow();
    expect(() => decodeRequestClosed({ ...request, eligibilityRules: [{ kind: 'CART_TOTAL' }] })).toThrow();
    expect(() => decodeRequestClosed({ ...request, usageLimit: 1 })).toThrow();
    expect(decodeRequestClosed(request)).toEqual(request);
  });

  it('represents invalid, conflict, unavailable, unverifiable, and parked owner outcomes distinctly', () => {
    const invalid = Schema.decodeSync(PromotionContributionInvalidSchema)({
      _tag: 'PROMOTION_CONTRIBUTION_INVALID',
      reason: 'CANDIDATE_BINDING_MISMATCH',
      request,
      retryable: false,
    });
    expect(Schema.is(PromotionContributionInvalidSchema)(invalid)).toBe(true);
    const conflict = Schema.decodeSync(PromotionContributionConflictSchema)({
      _tag: 'PROMOTION_CONTRIBUTION_CONFLICT',
      conflictingApplicationRefs: ['voucher-app:a', 'voucher-app:b'],
      reason: 'MULTIPLE_AUTHORITATIVE_CONTRIBUTIONS',
      request,
      retryable: false,
    });
    expect(Schema.is(PromotionContributionConflictSchema)(conflict)).toBe(true);
    const unavailable = Schema.decodeSync(PromotionContributionUnavailableSchema)({
      _tag: 'PROMOTION_CONTRIBUTION_UNAVAILABLE',
      reason: 'OWNER_UNAVAILABLE',
      request,
      retryable: true,
    });
    expect(Schema.is(PromotionContributionUnavailableSchema)(unavailable)).toBe(true);
    const unverifiable = Schema.decodeSync(PromotionContributionUnverifiableSchema)({
      _tag: 'PROMOTION_CONTRIBUTION_UNVERIFIABLE',
      missingEvidenceRefs: ['promotion-proof:775'],
      reason: 'EVIDENCE_STALE',
      request,
      retryable: true,
    });
    expect(Schema.is(PromotionContributionUnverifiableSchema)(unverifiable)).toBe(true);
    const parked = Schema.decodeUnknownSync(PromotionContributionParkedSchema)({
      _tag: 'PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS',
      applicationIdentity,
      ownerEvidence,
      reason: 'NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION',
      request: {
        ...request,
        prePromotionBasis: {
          ...prePromotionBasis,
          lines: [
            { ...prePromotionBasis.lines[0], amount: money('0') },
            { ...prePromotionBasis.lines[1], amount: money('-1') },
          ],
        },
      },
    });
    expect(Schema.is(PromotionContributionParkedSchema)(parked)).toBe(true);
  });
});
