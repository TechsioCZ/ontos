import type { PromotionContributionSourcePort } from '@app/pricing-contracts/domain/promotion-contribution';
import { PricingPromotionCompositionFailedSchema } from '@app/pricing-contracts/domain/promotion-composition';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  publishPricingPromotionCurrentEvaluation,
  publishPricingPromotionFailure,
} from '../../src/services/promotion-composition-result.service.ts';
import {
  makePricingPromotionCompositionService,
  PricingPromotionUnavailable,
  PricingPromotionUnverifiable,
} from '../../src/services/promotion-contribution-composition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK',
  lines: [
    {
      catalog: {
        completeness: {
          observedAt: operationTime,
          ownerRevision: 'catalog-quantity-r776',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-quantity:line-a' },
        },
        divisible: false,
        equivalentSelectionKey: 'catalog-selection:line-a',
        evidence: {
          assessedAt: operationTime,
          basis: [
            { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
            { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 2 } },
            {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
              role: 'PRODUCT_TYPE_UNTYPED_DECISION',
              source: { resourceRef: selection.productRef, revision: 1 },
            },
          ],
          membership: {
            attestationId: '66666666-6666-4666-8666-666666666666',
            observedAt: operationTime,
            productRef: selection.productRef,
            source: 'CATALOG_OWNER_CURRENT_READ',
            variant: { resourceRef: selection.variantRef, revision: 2 },
          },
          purpose: 'PRICING',
          selection,
          status: 'VALID',
        },
        hierarchyRevision: 'catalog-hierarchy-r776',
        ownerRevision: 'catalog-quantity-r776',
        quantity: {
          changed: false,
          notice: null,
          requested: '1',
          resulting: '1',
          rounding: 'HALF_UP',
          status: 'VALID',
          step: '1',
          targetId: selection.variantRef.resourceId,
          tenantId,
          unitId: unitRef.resourceId,
          unitRuleRevision: 7,
        },
        quantityBasis: {
          targetDivisibilityRevision: 3,
          targetRef: selection.variantRef,
          unitRef,
          unitRuleRevision: 7,
        },
        selection,
        status: 'READY',
        unitRef,
      },
      occurrenceId: 'line-a',
      pricingBasis: { quantity: '1', unitRef },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:776',
      decisionRevision: 'purchase-access-decision-r776',
    },
    actor: {
      guestEvidenceRef: 'guest-session-776',
      guestSessionRef: 'guest-session-776',
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
      guestEvidenceRef: 'guest-session-776',
      guestSessionRef: 'guest-session-776',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const subjectEvidence = {
  evidenceRef: 'subject-proof-776',
  observedAt: operationTime,
  ownerModuleId: 'commerce.customer-context',
  ownerRevision: 'subject-r776',
  provenanceRef: 'subject-provenance-776',
  revalidatedAt: operationTime,
  subject: { guestEvidenceRef: 'guest-session-776', kind: 'GUEST' as const, tenantId },
};
const ownerEvidence = {
  completenessEvidence: {
    observedAt: operationTime,
    ownerRevision: 'promotion-r776',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'promotion-predicate-776' },
  },
  currentness: {
    evaluatedAt: operationTime,
    observedAt: operationTime,
    revalidatedAt: operationTime,
    status: 'CURRENT' as const,
  },
  exactPredicateRef: 'promotion-predicate-776',
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion-r776',
  provenanceRef: 'promotion-proof-776',
};
const input = {
  applicationRequestRef: 'voucher-request-776',
  candidateRef: 'pricing-candidate-776',
  currencyCompatibility: {
    currencyCode: 'CZK' as const,
    evidenceRef: 'currency-support-proof-776',
    observedAt: operationTime,
    ownerRevision: 'currency-support-r776',
    status: 'SUPPORTED_CURRENT' as const,
    tenantId,
  },
  decision,
  exactPredicateRef: 'promotion-predicate-776',
  pricingComposition: {
    allocationResults: [],
    composedLines: [
      {
        multiLineAllocations: [],
        occurrenceId: 'line-a',
        preAllocationIntermediateValue: money('800'),
        rawPostAllocationValue: money('800'),
        recipientKind: 'MERCHANDISE' as const,
      },
    ],
    decision,
    lineIntermediates: [
      {
        baseLineValue: money('800'),
        discountableLineBasis: money('800'),
        feeContributions: [],
        lineDiscountContributions: [],
        occurrenceId: 'line-a',
        recipientKind: 'MERCHANDISE' as const,
        value: money('800'),
      },
    ],
    outcome: 'ALLOCATION_COMPOSITION_READY' as const,
  },
  pricingCompositionRef: 'pricing-composition-776',
  pricingCompositionRevision: 'pricing-composition-r776',
  subjectEvidence,
};
const source: PromotionContributionSourcePort = {
  evaluate: (request) =>
    Effect.succeed({
      _tag: 'PROMOTION_CONTRIBUTION_APPLIED',
      allocations: [
        {
          amount: money('-80'),
          catalogSelection: selection,
          occurrenceId: 'line-a',
          recipientKind: 'MERCHANDISE',
        },
      ],
      applicationIdentity: {
        applicationKind: 'PROMOTION_APPLICATION',
        applicationRef: 'voucher-application-776',
        applicationRevision: 'voucher-application-r776',
        originalApplicationRef: request.applicationRequestRef,
      },
      contribution: money('-80'),
      ownerEvidence,
      request,
      target: { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a'] },
    }),
};

describe('Pricing Promotion result publication', () => {
  it.effect('publishes the full accepted subject and one immutable owner proof', () =>
    Effect.gen(function* publishesLosslessEvidence() {
      const composition = yield* makePricingPromotionCompositionService(source).compose(input);
      const result = yield* publishPricingPromotionCurrentEvaluation({
        attempts: 1,
        composition,
        currentnessEvidence: ownerEvidence,
      });

      expect(result.currentnessEvidence.subjectEvidence).toEqual(subjectEvidence);
      expect(result.promotion.acceptedRequest.subjectEvidence).toEqual(subjectEvidence);
      expect(result.promotion.ownerEvidence).toEqual(ownerEvidence);
      expect(result.currentnessEvidence.ownerEvidence).toEqual(ownerEvidence);
      expect(result.promotion.ownerDecisionRevision).toBe(ownerEvidence.ownerRevision);
      expect(result.lines).toEqual([
        expect.objectContaining({
          catalogSelection: selection,
          occurrenceId: 'line-a',
          prePromotionValue: money('800'),
          rawPreTaxValue: money('720'),
        }),
      ]);
    }),
  );

  it.effect('rejects mixing owner allocations with currentness from another revision', () =>
    Effect.gen(function* rejectsMixedOwnerRevisions() {
      const composition = yield* makePricingPromotionCompositionService(source).compose(input);
      const changedEvidence = {
        ...ownerEvidence,
        completenessEvidence: { ...ownerEvidence.completenessEvidence, ownerRevision: 'promotion-r777' },
        ownerRevision: 'promotion-r777',
      };
      const failure = yield* publishPricingPromotionCurrentEvaluation({
        attempts: 1,
        composition,
        currentnessEvidence: changedEvidence,
      }).pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
    }),
  );

  it.effect('maps typed internal owner failures to the validated public failure contract', () =>
    Effect.gen(function* mapsPublicFailure() {
      const result = yield* publishPricingPromotionFailure(
        input.candidateRef,
        new PricingPromotionUnavailable({ reason: 'OWNER_UNAVAILABLE', retryable: true }),
      );

      expect(Schema.is(PricingPromotionCompositionFailedSchema)(result)).toBe(true);
      expect(result).toEqual({
        candidateRef: input.candidateRef,
        failure: { reason: 'OWNER_UNAVAILABLE', retryable: true, type: 'OWNER_UNAVAILABLE' },
        outcome: 'PROMOTION_COMPOSITION_FAILED',
      });
    }),
  );
});
