import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PromotionContributionAppliedSchema,
  PromotionContributionConflictSchema,
  PromotionContributionInvalidSchema,
  PromotionContributionOutcomeSchema,
  PromotionContributionParkedSchema,
  PromotionContributionRequestSchema,
  PromotionContributionUnavailableSchema,
  PromotionContributionUnverifiableSchema,
} from '@app/pricing-contracts/domain/promotion-contribution';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const selection = { productRef, variantRef };
const catalogEvidence = {
  assessedAt: '2026-09-28T07:59:59.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: '12121212-1212-4212-8212-121212121212',
    observedAt: '2026-09-28T07:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const catalog = {
  completeness: {
    observedAt: '2026-09-28T07:59:59.000Z',
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidence,
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY' as const,
  unitRef,
};
const line = (occurrenceId: string) => ({
  catalog,
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});
const decision = {
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK' as const,
  lines: [line('line-a'), line('line-b')],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-28T08:00:00.000Z',
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:1',
      decisionRevision: 'purchase-access-decision-r1',
    },
    actor: {
      guestEvidenceRef: 'guest-context:1',
      guestSessionRef: 'guest-session:1',
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:1',
      decisionRevision: 'purchase-commercial-settings-r1',
    },
    contextRef: 'purchase-1',
    contextRevision: 'purchase-r1',
    currencyResolution: {
      currencyCode: 'CZK' as const,
      resolutionRef: 'purchase-currency-resolution:1',
      resolutionRevision: 'purchase-currency-resolution-r1',
    },
    subject: {
      guestEvidenceRef: 'guest-context:1',
      guestSessionRef: 'guest-session:1',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
};
const exactPredicateRef = 'promotion:application-request-1:candidate-1';
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const request = {
  applicationRequestRef: 'application-request-1',
  candidate: { candidateRef: 'candidate-1', decision },
  currencyCompatibility: {
    currencyCode: 'CZK' as const,
    evidenceRef: 'pricing-currency-support:czk',
    observedAt: decision.operationTime,
    ownerRevision: 'pricing-currency-support:r7',
    status: 'SUPPORTED_CURRENT' as const,
    tenantId,
  },
  exactPredicateRef,
  prePromotionBasis: {
    completedPricingAllocationRefs: ['pricing-allocation:line', 'pricing-allocation:whole-purchase'],
    currencyCode: 'CZK' as const,
    lines: [
      { amount: money('720'), catalogSelection: selection, occurrenceId: 'line-a' },
      { amount: money('180'), catalogSelection: selection, occurrenceId: 'line-b' },
    ],
    monetaryBoundary: 'PRE_TAX' as const,
    pricingCompositionRef: 'pricing-composition:1',
    pricingCompositionRevision: 'pricing-composition:r9',
    stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS' as const,
  },
  subjectEvidence: {
    evidenceRef: 'guest-context:1',
    observedAt: decision.operationTime,
    ownerModuleId: 'commerce.customer-context',
    ownerRevision: 'customer-context:r41',
    provenanceRef: 'guest-session:1',
    revalidatedAt: '2026-09-28T08:00:00.001Z',
    subject: { guestEvidenceRef: 'guest-session:1', kind: 'GUEST' as const, tenantId },
  },
};
const ownerEvidence = {
  completenessEvidence: {
    observedAt: '2026-09-28T08:00:00.001Z',
    ownerRevision: 'promotion:r11',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: exactPredicateRef },
  },
  currentness: {
    evaluatedAt: decision.operationTime,
    observedAt: '2026-09-28T08:00:00.001Z',
    revalidatedAt: '2026-09-28T08:00:00.002Z',
    status: 'CURRENT' as const,
  },
  exactPredicateRef,
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion:r11',
  provenanceRef: 'promotion-decision:11',
};
const applicationIdentity = {
  applicationKind: 'PROMOTION_APPLICATION' as const,
  applicationRef: 'promotion-application:11',
  applicationRevision: 'promotion-application:r11',
  originalApplicationRef: request.applicationRequestRef,
};
const merchandiseAllocation = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  catalogSelection: selection,
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const applied = {
  _tag: 'PROMOTION_CONTRIBUTION_APPLIED' as const,
  allocations: [merchandiseAllocation('line-a', '-80'), merchandiseAllocation('line-b', '-20')],
  applicationIdentity,
  contribution: money('-100'),
  ownerEvidence,
  request,
  target: { kind: 'MERCHANDISE_ONLY' as const, occurrenceIds: ['line-a', 'line-b'] },
};

const decodeRequest = Schema.decodeUnknownSync(PromotionContributionRequestSchema, { onExcessProperty: 'error' });
const decodeApplied = Schema.decodeUnknownSync(PromotionContributionAppliedSchema, { onExcessProperty: 'error' });
const decodeParked = Schema.decodeUnknownSync(PromotionContributionParkedSchema, { onExcessProperty: 'error' });
const decodeOutcome = Schema.decodeUnknownSync(PromotionContributionOutcomeSchema, { onExcessProperty: 'error' });

describe('Promotion owner-issued contribution contract (#775)', () => {
  it('binds the exact candidate, stable recipients, Variant selections, commercial scope, subject, and currency', () => {
    expect(decodeRequest(request)).toEqual(request);
    expect(Schema.is(PromotionContributionAppliedSchema)(decodeApplied(applied))).toBe(true);

    expect(() =>
      decodeRequest({
        ...request,
        currencyCompatibility: { ...request.currencyCompatibility, currencyCode: 'EUR' },
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        currencyCompatibility: {
          ...request.currencyCompatibility,
          tenantId: '99999999-9999-4999-8999-999999999999',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        prePromotionBasis: { ...request.prePromotionBasis, lines: request.prePromotionBasis.lines.slice(0, 1) },
      }),
    ).toThrow();
  });

  it('requires exact non-positive allocations and does not include Shipping implicitly', () => {
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [merchandiseAllocation('line-a', '-110'), merchandiseAllocation('line-b', '10')],
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [merchandiseAllocation('line-a', '-50'), merchandiseAllocation('line-a', '-50')],
      }),
    ).toThrow();
    expect(() =>
      decodeApplied({
        ...applied,
        allocations: [
          ...applied.allocations,
          { amount: money('-10'), deliveryComponentRef: 'delivery:1', recipientKind: 'SHIPPING' as const },
        ],
        contribution: money('-110'),
      }),
    ).toThrow();

    const explicitShipping = {
      ...applied,
      allocations: [
        merchandiseAllocation('line-a', '-70'),
        merchandiseAllocation('line-b', '-20'),
        { amount: money('-10'), deliveryComponentRef: 'delivery:1', recipientKind: 'SHIPPING' as const },
      ],
      target: {
        kind: 'BASKET_WITH_EXPLICIT_SHIPPING' as const,
        occurrenceIds: ['line-a', 'line-b'],
        shippingComponentRefs: ['delivery:1'],
      },
    };
    expect(Schema.is(PromotionContributionAppliedSchema)(decodeApplied(explicitShipping))).toBe(true);
  });

  it('keeps zero and non-positive eligible basis on the explicit parked owner path', () => {
    const parkedRequest = {
      ...request,
      prePromotionBasis: {
        ...request.prePromotionBasis,
        lines: [
          { amount: money('-10'), catalogSelection: selection, occurrenceId: 'line-a' },
          { amount: money('10'), catalogSelection: selection, occurrenceId: 'line-b' },
        ],
      },
    };
    const parked = {
      _tag: 'PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS' as const,
      applicationIdentity,
      ownerEvidence,
      reason: 'NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION' as const,
      request: parkedRequest,
    };
    expect(Schema.is(PromotionContributionParkedSchema)(decodeParked(parked))).toBe(true);
    expect(() => decodeApplied({ ...applied, request: parkedRequest })).toThrow();
    expect(() => decodeParked({ ...parked, request })).toThrow();
  });

  it('preserves typed invalid, conflict, unavailable, and unverifiable outcomes', () => {
    expect(
      Schema.is(PromotionContributionInvalidSchema)(
        decodeOutcome({
          _tag: 'PROMOTION_CONTRIBUTION_INVALID',
          reason: 'CANDIDATE_BINDING_MISMATCH',
          request,
          retryable: false,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PromotionContributionConflictSchema)(
        decodeOutcome({
          _tag: 'PROMOTION_CONTRIBUTION_CONFLICT',
          conflictingApplicationRefs: ['promotion:1', 'promotion:2'],
          reason: 'MULTIPLE_AUTHORITATIVE_CONTRIBUTIONS',
          request,
          retryable: false,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PromotionContributionUnavailableSchema)(
        decodeOutcome({
          _tag: 'PROMOTION_CONTRIBUTION_UNAVAILABLE',
          reason: 'OWNER_UNAVAILABLE',
          request,
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PromotionContributionUnverifiableSchema)(
        decodeOutcome({
          _tag: 'PROMOTION_CONTRIBUTION_UNVERIFIABLE',
          missingEvidenceRefs: ['promotion-current-set'],
          reason: 'EVIDENCE_UNVERIFIABLE',
          request,
          retryable: true,
        }),
      ),
    ).toBe(true);
  });
});
