import type {
  PromotionContributionApplied,
  PromotionContributionOutcome,
  PromotionContributionRequest,
  PromotionContributionSourcePort,
} from '@app/pricing-contracts/domain/promotion-contribution';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { composePricingDiscountFeeAllocations } from '../../src/services/discount-fee-allocation-composition.service.ts';
import type {
  PricingPromotionCompositionFailure,
  PricingPromotionCompositionInput,
  PricingPromotionCompositionResult,
} from '../../src/services/promotion-contribution-composition.service.ts';
import {
  makePricingPromotionCompositionService,
  PricingPromotionConflict,
  PricingPromotionParked,
  PricingPromotionUnavailable,
  PricingPromotionUnverifiable,
} from '../../src/services/promotion-contribution-composition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
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
      guestEvidenceRef: 'guest-session:775',
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
      guestEvidenceRef: 'guest-session:775',
      guestSessionRef: 'guest-session:775',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: 'pricing-allocation-v1' as const,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC' as const,
} as const;
const lineDiscount = (occurrenceId: 'line-a' | 'line-b', basis: string, amount: string) => ({
  amount: money(amount),
  basis: { amount: money(basis), occurrenceId },
  candidate: {
    definition: { discountId: `line-discount:${occurrenceId}`, revision: { revisionId: `line-r775:${occurrenceId}` } },
    occurrenceId,
  },
});
const feeResult = (occurrenceId: 'line-a' | 'line-b', amount: string) => ({
  contributions: [],
  contributionTotal: money('0'),
  discountableLineBasis: money(amount),
  input: { baseLineValue: money(amount), decision, occurrenceId },
  outcome: 'COMMERCIAL_FEES_APPLIED' as const,
});

const makePostPricingComposition = Effect.fn('test.makePostPricingComposition')(function* makePostPricingComposition() {
  const result = yield* composePricingDiscountFeeAllocations({
    discountComposition: {
      lineContributions: [lineDiscount('line-a', '1000', '-100'), lineDiscount('line-b', '250', '-25')],
      outcome: 'DISCOUNT_COMPOSITION_READY',
      request: {
        decision,
        lineBases: [
          {
            amount: money('1000'),
            applicablePricingFeeTotal: money('0'),
            baseLineValue: money('1000'),
            occurrenceId: 'line-a',
          },
          {
            amount: money('250'),
            applicablePricingFeeTotal: money('0'),
            baseLineValue: money('250'),
            occurrenceId: 'line-b',
          },
        ],
      },
      wholePurchaseContribution: {
        amount: money('-125'),
        candidate: {
          applicability: {
            basis: {
              currencyCode: 'CZK',
              eligibleAmount: '1125',
              recipients: [
                { intermediateValue: money('900'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
                { intermediateValue: money('225'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
              ],
            },
          },
          definition: { discountId: 'whole-discount:775', revision: { revisionId: 'whole-r775' } },
        },
      },
    },
    feeResults: [feeResult('line-a', '1000'), feeResult('line-b', '250')],
    precision,
    recipientClassifications: [
      { occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
      { occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
    ],
  });
  if (result.outcome !== 'ALLOCATION_COMPOSITION_READY') {
    return yield* Effect.die('Expected the Pricing allocation composition to be ready');
  }
  return result;
});

const subjectEvidence = {
  evidenceRef: 'commerce-subject:guest-775',
  observedAt: operationTime,
  ownerModuleId: 'commerce.customer-context',
  ownerRevision: 'commerce-subject-r775',
  provenanceRef: 'commerce-subject-proof:775',
  revalidatedAt: operationTime,
  subject: { guestEvidenceRef: 'guest-session:775', kind: 'GUEST' as const, tenantId },
};
const currencyCompatibility = {
  currencyCode: 'CZK' as const,
  evidenceRef: 'pricing-currency-support:775',
  observedAt: operationTime,
  ownerRevision: 'pricing-currency-support-r775',
  status: 'SUPPORTED_CURRENT' as const,
  tenantId,
};
const makeInput = (
  pricingComposition: PricingPromotionCompositionInput['pricingComposition'],
): PricingPromotionCompositionInput => ({
  applicationRequestRef: 'voucher-request:775',
  candidateRef: 'pricing-candidate:775',
  currencyCompatibility,
  decision,
  exactPredicateRef: 'promotion-contribution:pricing-candidate:775',
  pricingComposition,
  pricingCompositionRef: 'pricing-composition:775',
  pricingCompositionRevision: 'pricing-composition-r775',
  subjectEvidence,
});
const ownerEvidence = (request: PromotionContributionRequest) => ({
  completenessEvidence: {
    nextApplicabilityBoundary: '2026-09-28T08:01:00.000Z',
    observedAt: operationTime,
    ownerRevision: 'promotion-current-r775',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: request.exactPredicateRef },
  },
  currentness: {
    evaluatedAt: operationTime,
    observedAt: operationTime,
    revalidatedAt: operationTime,
    status: 'CURRENT' as const,
  },
  exactPredicateRef: request.exactPredicateRef,
  ownerModuleId: 'commerce.promotion' as const,
  ownerRevision: 'promotion-current-r775',
  provenanceRef: 'promotion-proof:775',
});
const applicationIdentity = (request: PromotionContributionRequest) => ({
  applicationKind: 'PROMOTION_APPLICATION' as const,
  applicationRef: 'voucher-application:775',
  applicationRevision: 'voucher-application-r775',
  originalApplicationRef: request.applicationRequestRef,
});
const appliedOutcome = (
  request: PromotionContributionRequest,
  options?: { readonly shipping?: boolean },
): PromotionContributionApplied => ({
  _tag: 'PROMOTION_CONTRIBUTION_APPLIED',
  allocations: [
    {
      amount: money('-80'),
      catalogSelection: selection('a'),
      occurrenceId: 'line-a',
      recipientKind: 'MERCHANDISE',
    },
    {
      amount: money('-20'),
      catalogSelection: selection('b'),
      occurrenceId: 'line-b',
      recipientKind: 'MERCHANDISE',
    },
    ...(options?.shipping === true
      ? [{ amount: money('-20'), deliveryComponentRef: 'delivery-component:775', recipientKind: 'SHIPPING' as const }]
      : []),
  ],
  applicationIdentity: applicationIdentity(request),
  contribution: money(options?.shipping === true ? '-120' : '-100'),
  ownerEvidence: ownerEvidence(request),
  request,
  target:
    options?.shipping === true
      ? {
          kind: 'BASKET_WITH_EXPLICIT_SHIPPING',
          occurrenceIds: ['line-a', 'line-b'],
          shippingComponentRefs: ['delivery-component:775'],
        }
      : { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a', 'line-b'] },
});
const source = (
  evaluate: (request: PromotionContributionRequest) => PromotionContributionOutcome,
): PromotionContributionSourcePort => ({ evaluate: (request) => Effect.succeed(evaluate(request)) });
const expectFailureTag = Effect.fn('test.expectPromotionFailureTag')(function* expectPromotionFailureTag(
  input: PricingPromotionCompositionInput,
  ownerSource: PromotionContributionSourcePort,
  expected: (failure: PricingPromotionCompositionFailure) => boolean,
) {
  const failure = yield* Effect.flip(makePricingPromotionCompositionService(ownerSource).compose(input));
  expect(expected(failure)).toBe(true);
});
const rawTotal = (result: PricingPromotionCompositionResult): number =>
  result.lines.reduce((sum, lineResult) => sum + Number(lineResult.rawPreTaxValue.amount), 0);

describe('issue #775 Pricing Promotion contribution acceptance', () => {
  it.effect('uses exact post-line-and-whole-purchase Pricing values and applies 800+200 -> -80/-20 exactly once', () =>
    Effect.gen(function* appliesAfterAllPricingDiscounts() {
      const pricingComposition = yield* makePostPricingComposition();
      expect(
        pricingComposition.composedLines.map(({ rawPostAllocationValue }) => rawPostAllocationValue.amount),
      ).toEqual(['800', '200']);

      const result = yield* makePricingPromotionCompositionService(source(appliedOutcome)).compose(
        makeInput(pricingComposition),
      );
      expect(result.outcome).toBe('PROMOTION_COMPOSITION_APPLIED');
      expect(result.lines.map(({ prePromotionValue }) => prePromotionValue.amount)).toEqual(['800', '200']);
      expect(result.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);
      expect(rawTotal(result)).toBe(900);
      expect(result.request.prePromotionBasis.completedPricingAllocationRefs).toEqual(
        expect.arrayContaining([
          'pricing-composition:775',
          'commerce.pricing:line-discount:line-a:line-r775:line-a',
          'commerce.pricing:line-discount:line-b:line-r775:line-b',
          'commerce.pricing:whole-discount:775:whole-r775',
        ]),
      );
    }),
  );

  it.effect(
    'keeps default Voucher scope on merchandise and retains explicit Shipping in the Delivery component only',
    () =>
      Effect.gen(function* preservesDeliveryOwnership() {
        const input = makeInput(yield* makePostPricingComposition());
        const defaultResult = yield* makePricingPromotionCompositionService(source(appliedOutcome)).compose(input);
        expect(defaultResult.shippingAllocations).toEqual([]);
        expect(defaultResult.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);

        const explicitResult = yield* makePricingPromotionCompositionService(
          source((request) => appliedOutcome(request, { shipping: true })),
        ).compose(input);
        expect(explicitResult.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);
        expect(explicitResult.shippingAllocations).toEqual([
          { amount: money('-20'), deliveryComponentRef: 'delivery-component:775', recipientKind: 'SHIPPING' },
        ]);
        expect(rawTotal(explicitResult)).toBe(900);
      }),
  );

  it.effect(
    'is Storefront-independent for identical backend facts and never forwards application IDs to Promotion',
    () =>
      Effect.gen(function* ignoresApplicationPresentationIdentity() {
        const input = makeInput(yield* makePostPricingComposition());
        const seenRequests: PromotionContributionRequest[] = [];
        const service = makePricingPromotionCompositionService(
          source((request) => {
            seenRequests.push(request);
            return appliedOutcome(request);
          }),
        );
        const firstInput = { ...input, storefrontAppId: 'storefront-a' };
        const secondInput = { ...input, storefrontAppId: 'storefront-b' };
        const first = yield* service.compose(firstInput);
        const second = yield* service.compose(secondInput);
        expect(first.lines).toEqual(second.lines);
        expect(seenRequests).toHaveLength(2);
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(seenRequests)).not.toContain(
          'storefront',
        );
      }),
  );

  it.effect(
    'fails typed for another Market/subject, stale or missing evidence, conflict, and owner unavailability',
    () =>
      Effect.gen(function* rejectsOwnerDefects() {
        const input = makeInput(yield* makePostPricingComposition());
        yield* expectFailureTag(
          input,
          source((request) => ({
            ...appliedOutcome(request),
            request: {
              ...request,
              candidate: {
                ...request.candidate,
                decision: {
                  ...request.candidate.decision,
                  commercialScope: { ...request.candidate.decision.commercialScope, marketId: 'another-market' },
                },
              },
            },
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
        yield* expectFailureTag(
          input,
          source((request) => ({
            ...appliedOutcome(request),
            request: {
              ...request,
              subjectEvidence: {
                ...request.subjectEvidence,
                subject: { ...request.subjectEvidence.subject, guestEvidenceRef: 'another-guest-session' },
              },
            },
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
        yield* expectFailureTag(
          input,
          source((request) => ({
            ...appliedOutcome(request),
            ownerEvidence: {
              ...ownerEvidence(request),
              currentness: { ...ownerEvidence(request).currentness, revalidatedAt: '2026-09-28T07:59:59.000Z' },
            },
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
        yield* expectFailureTag(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_UNVERIFIABLE',
            missingEvidenceRefs: ['promotion-proof:775'],
            reason: 'EVIDENCE_INCOMPLETE',
            request,
            retryable: true,
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
        yield* expectFailureTag(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_CONFLICT',
            conflictingApplicationRefs: ['voucher-app:a', 'voucher-app:b'],
            reason: 'MULTIPLE_AUTHORITATIVE_CONTRIBUTIONS',
            request,
            retryable: false,
          })),
          Schema.is(PricingPromotionConflict),
        );
        yield* expectFailureTag(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_UNAVAILABLE',
            reason: 'OWNER_UNAVAILABLE',
            request,
            retryable: true,
          })),
          Schema.is(PricingPromotionUnavailable),
        );
      }),
  );

  it.effect('rejects currency mismatch without calling Promotion or performing FX', () =>
    Effect.gen(function* rejectsForeignCompatibility() {
      const input = makeInput(yield* makePostPricingComposition());
      let ownerCalls = 0;
      const service = makePricingPromotionCompositionService({
        evaluate: (request) => {
          ownerCalls += 1;
          return Effect.succeed(appliedOutcome(request));
        },
      });
      const failure = yield* Effect.flip(
        service.compose({
          ...input,
          currencyCompatibility: { ...input.currencyCompatibility, currencyCode: 'EUR' },
        }),
      );
      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('rejects same-CZK Currency Support evidence from another Tenant before calling Promotion', () =>
    Effect.gen(function* rejectsCrossTenantCurrencyEvidence() {
      const input = makeInput(yield* makePostPricingComposition());
      let ownerCalls = 0;
      const service = makePricingPromotionCompositionService({
        evaluate: (request) => {
          ownerCalls += 1;
          return Effect.succeed(appliedOutcome(request));
        },
      });
      const exact = yield* service.compose(input);
      expect(exact.request.currencyCompatibility.tenantId).toBe(tenantId);
      expect(ownerCalls).toBe(1);

      const failure = yield* Effect.flip(
        service.compose({
          ...input,
          currencyCompatibility: {
            ...input.currencyCompatibility,
            tenantId: '99999999-9999-4999-8999-999999999999',
          },
        }),
      );
      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(ownerCalls).toBe(1);
    }),
  );

  it.effect('consumes owner non-applicability without re-evaluating eligibility or usage', () =>
    Effect.gen(function* consumesOwnerDecisionOnly() {
      const input = makeInput(yield* makePostPricingComposition());
      const result = yield* makePricingPromotionCompositionService(
        source((request) => ({
          _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
          ownerEvidence: ownerEvidence(request),
          reason: 'APPLICATION_NOT_ELIGIBLE',
          request,
        })),
      ).compose(input);
      expect(result.outcome).toBe('PROMOTION_COMPOSITION_NOT_APPLICABLE');
      expect(result.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['800', '200']);
      expect(rawTotal(result)).toBe(1000);
    }),
  );

  it.effect('defers zero/non-positive eligible basis to the parked owner outcome and fabricates no success', () =>
    Effect.gen(function* parksUndefinedOwnerEdge() {
      const pricingComposition = yield* makePostPricingComposition();
      const zeroComposition = {
        ...pricingComposition,
        allocationResults: [],
        composedLines: pricingComposition.composedLines.map((composed) => ({
          ...composed,
          multiLineAllocations: [],
          preAllocationIntermediateValue: money('0'),
          rawPostAllocationValue: money('0'),
        })),
        lineIntermediates: pricingComposition.lineIntermediates.map((intermediate) => ({
          ...intermediate,
          baseLineValue: money('0'),
          discountableLineBasis: money('0'),
          feeContributions: [],
          lineDiscountContributions: [],
          value: money('0'),
        })),
      };
      const input = makeInput(zeroComposition);
      yield* expectFailureTag(
        input,
        source((request) => ({
          _tag: 'PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS',
          applicationIdentity: applicationIdentity(request),
          ownerEvidence: ownerEvidence(request),
          reason: 'NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION',
          request,
        })),
        Schema.is(PricingPromotionParked),
      );
      yield* expectFailureTag(input, source(appliedOutcome), Schema.is(PricingPromotionUnverifiable));
    }),
  );
});
