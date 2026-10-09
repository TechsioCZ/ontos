import type {
  PromotionContributionRequest,
  PromotionContributionSourcePort,
} from '@app/pricing-contracts/domain/promotion-contribution';
import type { PricingOwnerExactAllocationRequest } from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import type { PricingPromotionCompositionInput } from '../../src/services/promotion-contribution-composition.service.ts';
import {
  makePricingPromotionCompositionService,
  PricingPromotionUnavailable,
  PricingPromotionUnverifiable,
  unavailablePromotionContributionSource,
} from '../../src/services/promotion-contribution-composition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const exactPredicateRef = 'promotion:exact:purchase-775';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const selection = (suffix: string) => ({
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: `22222222-2222-4222-8222-2222222222${suffix}`,
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: `33333333-3333-4333-8333-3333333333${suffix}`,
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
});
const line = (occurrenceId: string, suffix: string) => {
  const catalogSelection = selection(suffix);
  return {
    catalog: {
      completeness: {
        observedAt: operationTime,
        ownerRevision: 'catalog-quantity:775',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog:${occurrenceId}` },
      },
      divisible: false,
      equivalentSelectionKey: `catalog-selection:${occurrenceId}`,
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
          attestationId: `66666666-6666-4666-8666-6666666666${suffix}`,
          observedAt: operationTime,
          productRef: catalogSelection.productRef,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
          variant: { resourceRef: catalogSelection.variantRef, revision: 2 },
        },
        purpose: 'PRICING' as const,
        selection: catalogSelection,
        status: 'VALID' as const,
      },
      hierarchyRevision: 'catalog-hierarchy:775',
      ownerRevision: 'catalog-quantity:775',
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
  lines: [line('line-a', '22'), line('line-b', '33')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:775',
      decisionRevision: 'purchase-access-decision-r775',
    },
    actor: {
      guestEvidenceRef: 'guest-context-775',
      guestSessionRef: 'guest-session-775',
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
      guestEvidenceRef: 'guest-context-775',
      guestSessionRef: 'guest-session-775',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const allocation = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const compositionLine = (occurrenceId: string, amount: string) => ({
  multiLineAllocations: [],
  occurrenceId,
  preAllocationIntermediateValue: money(amount),
  rawPostAllocationValue: money(amount),
  recipientKind: 'MERCHANDISE' as const,
});
const intermediate = (occurrenceId: string, amount: string) => ({
  baseLineValue: money(amount),
  discountableLineBasis: money(amount),
  feeContributions: [],
  lineDiscountContributions: [],
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
  value: money(amount),
});
const input: PricingPromotionCompositionInput = {
  applicationRequestRef: 'voucher-application-request-775',
  candidateRef: 'pricing-candidate-775',
  currencyCompatibility: {
    currencyCode: 'CZK',
    evidenceRef: 'currency-support-evidence-775',
    observedAt: operationTime,
    ownerRevision: 'currency-support-r775',
    status: 'SUPPORTED_CURRENT',
    tenantId,
  },
  decision,
  exactPredicateRef,
  pricingComposition: {
    allocationResults: [],
    composedLines: [compositionLine('line-a', '800'), compositionLine('line-b', '200')],
    decision,
    lineIntermediates: [intermediate('line-a', '800'), intermediate('line-b', '200')],
    outcome: 'ALLOCATION_COMPOSITION_READY',
  },
  pricingCompositionRef: 'pricing-composition-775',
  pricingCompositionRevision: 'pricing-composition-r775',
  subjectEvidence: {
    evidenceRef: 'guest-evidence-775',
    observedAt: operationTime,
    ownerModuleId: 'commerce.customer-context',
    ownerRevision: 'guest-r775',
    provenanceRef: 'guest-provenance-775',
    revalidatedAt: operationTime,
    subject: { guestEvidenceRef: 'guest-context-775', kind: 'GUEST', tenantId },
  },
};

const ownerEvidence = {
  completenessEvidence: {
    observedAt: operationTime,
    ownerRevision: 'promotion-r775',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: exactPredicateRef },
  },
  currentness: {
    evaluatedAt: operationTime,
    observedAt: operationTime,
    revalidatedAt: operationTime,
    status: 'CURRENT' as const,
  },
  exactPredicateRef,
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion-r775',
  provenanceRef: 'promotion-provenance-775',
};

describe('Pricing Promotion contribution composition', () => {
  it.effect('uses the exact post-#774 basis and applies owner allocations exactly once', () =>
    Effect.gen(function* appliesExactOwnerAllocations() {
      let capturedRequest: PromotionContributionRequest | undefined;
      const source: PromotionContributionSourcePort = {
        evaluate: (request) => {
          capturedRequest = request;
          return Effect.succeed({
            _tag: 'PROMOTION_CONTRIBUTION_APPLIED',
            allocations: [
              {
                amount: money('-80'),
                catalogSelection: selection('22'),
                occurrenceId: 'line-a',
                recipientKind: 'MERCHANDISE',
              },
              {
                amount: money('-20'),
                catalogSelection: selection('33'),
                occurrenceId: 'line-b',
                recipientKind: 'MERCHANDISE',
              },
            ],
            applicationIdentity: {
              applicationKind: 'PROMOTION_APPLICATION',
              applicationRef: 'promotion-application-775',
              applicationRevision: 'promotion-application-r775',
              originalApplicationRef: request.applicationRequestRef,
            },
            contribution: money('-100'),
            ownerEvidence,
            request,
            target: { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a', 'line-b'] },
          });
        },
      };

      const result = yield* makePricingPromotionCompositionService(source).compose(input);

      expect(capturedRequest?.prePromotionBasis).toMatchObject({
        completedPricingAllocationRefs: ['pricing-composition-775'],
        lines: [{ amount: money('800') }, { amount: money('200') }],
        stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS',
      });
      expect(result).toMatchObject({
        lines: [
          { occurrenceId: 'line-a', prePromotionValue: money('800'), rawPreTaxValue: money('720') },
          { occurrenceId: 'line-b', prePromotionValue: money('200'), rawPreTaxValue: money('180') },
        ],
        outcome: 'PROMOTION_COMPOSITION_APPLIED',
        shippingAllocations: [],
      });
    }),
  );

  it.effect('rejects substituted composed allocations that are not the exact #774 output', () =>
    Effect.gen(function* rejectsSubstitutedPricingAllocations() {
      const request: PricingOwnerExactAllocationRequest = {
        allocationKind: 'OWNER_EXACT',
        decision,
        originalContribution: money('-100'),
        ownerAllocations: [allocation('line-a', '-80'), allocation('line-b', '-20')],
        ownerScope: 'MULTI_LINE',
        precision: {
          allocationScale: 18,
          amountPrecision: 76,
          contractVersion: 'pricing-allocation-v1',
          remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
        },
        source: {
          allocationAuthority: 'OWNER_EXACT',
          logicalFactRef: 'contractual-discount-776',
          ownerModuleId: 'commerce.pricing',
          revisionRef: 'contractual-discount-r776',
          sourceKind: 'PRICING_DISCOUNT',
        },
      };
      const exactAllocationResult = yield* allocatePricingDiscountsAndFees(request);
      const substitutedInput: PricingPromotionCompositionInput = {
        ...input,
        pricingComposition: {
          allocationResults: [exactAllocationResult],
          composedLines: [
            {
              ...compositionLine('line-a', '740'),
              multiLineAllocations: [allocation('line-a', '-60')],
              preAllocationIntermediateValue: money('800'),
            },
            {
              ...compositionLine('line-b', '160'),
              multiLineAllocations: [allocation('line-b', '-40')],
              preAllocationIntermediateValue: money('200'),
            },
          ],
          decision,
          lineIntermediates: [intermediate('line-a', '800'), intermediate('line-b', '200')],
          outcome: 'ALLOCATION_COMPOSITION_READY',
        },
      };
      let ownerCalls = 0;
      const source: PromotionContributionSourcePort = {
        evaluate: () => {
          ownerCalls += 1;
          return Effect.die('Promotion must not receive substituted #774 allocations');
        },
      };

      const failure = yield* makePricingPromotionCompositionService(source).compose(substitutedInput).pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(failure.reason).toContain('exact completed Pricing allocations');
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('rejects replaying a Pricing composition across commercial scope before calling Promotion', () =>
    Effect.gen(function* rejectsCrossScopeCompositionReplay() {
      const otherDecision = yield* Schema.decodeEffect(PricingDecisionSchema)({
        ...decision,
        commercialScope: { ...decision.commercialScope, channelId: 'B2B' },
      });
      let ownerCalls = 0;
      const source: PromotionContributionSourcePort = {
        evaluate: () => {
          ownerCalls += 1;
          return Effect.die('Promotion must not receive a replayed Pricing composition');
        },
      };

      const failure = yield* makePricingPromotionCompositionService(source)
        .compose({
          ...input,
          pricingComposition: { ...input.pricingComposition, decision: otherDecision },
        })
        .pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(failure.reason).toContain('exact candidate Decision');
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('fails closed with a typed unavailable error when the parked owner runtime is absent', () =>
    Effect.gen(function* failsClosedWithoutOwnerRuntime() {
      const failure = yield* makePricingPromotionCompositionService(unavailablePromotionContributionSource)
        .compose(input)
        .pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'OWNER_UNAVAILABLE', retryable: true });
    }),
  );

  it.effect('rejects cross-Tenant same-currency support evidence before calling Promotion', () =>
    Effect.gen(function* rejectsCrossTenantCurrencyEvidence() {
      let ownerCalls = 0;
      const source: PromotionContributionSourcePort = {
        evaluate: () => {
          ownerCalls += 1;
          return Effect.die('Promotion must not be called for cross-Tenant currency evidence');
        },
      };
      const failure = yield* makePricingPromotionCompositionService(source)
        .compose({
          ...input,
          currencyCompatibility: {
            ...input.currencyCompatibility,
            tenantId: '99999999-9999-4999-8999-999999999999',
          },
        })
        .pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('preserves proven non-applicability without fabricating a zero contribution', () =>
    Effect.gen(function* preservesProvenAbsence() {
      const source: PromotionContributionSourcePort = {
        evaluate: (request) =>
          Effect.succeed({
            _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
            ownerEvidence,
            reason: 'NO_APPLICABLE_APPLICATION',
            request,
          }),
      };

      const result = yield* makePricingPromotionCompositionService(source).compose(input);

      expect(result).toMatchObject({
        lines: [
          { occurrenceId: 'line-a', rawPreTaxValue: money('800') },
          { occurrenceId: 'line-b', rawPreTaxValue: money('200') },
        ],
        outcome: 'PROMOTION_COMPOSITION_NOT_APPLICABLE',
      });
    }),
  );
});
