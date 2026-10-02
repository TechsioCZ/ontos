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
} from '../../src/services/promotion-contribution-composition.service.ts';
import { makePricingPromotionCurrentEvaluationService } from '../../src/services/promotion-current-evaluation.service.ts';
import {
  makePricingPromotionCompositionService,
  PricingPromotionConflict,
  PricingPromotionInputInvalid,
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
  commercialScope: { channelId: 'B2C', marketId: 'market-cz', sellingLegalEntityId },
  currencyCode: 'CZK',
  lines: [line('line-a', 'a'), line('line-b', 'b')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:776',
      decisionRevision: 'purchase-access-decision-r776',
    },
    actor: {
      guestEvidenceRef: 'guest-session:776',
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
      guestEvidenceRef: 'guest-session:776',
      guestSessionRef: 'guest-session:776',
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
const lineDiscount = (
  occurrenceId: 'line-a' | 'line-b',
  layer: 'group' | 'counterparty',
  basis: string,
  amount: string,
) => ({
  amount: money(amount),
  basis: { amount: money(basis), occurrenceId },
  candidate: {
    definition: {
      discountId: `${layer}-discount:${occurrenceId}`,
      revision: { revisionId: `${layer}-discount-r776:${occurrenceId}` },
    },
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

const makePostPricingComposition = Effect.fn('test.makeIssue776PostPricingComposition')(
  function* makeIssue776PostPricingComposition() {
    const result = yield* composePricingDiscountFeeAllocations({
      discountComposition: {
        lineContributions: [
          lineDiscount('line-a', 'group', '1000', '-60'),
          lineDiscount('line-a', 'counterparty', '1000', '-40'),
          lineDiscount('line-b', 'group', '250', '-15'),
          lineDiscount('line-b', 'counterparty', '250', '-10'),
        ],
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
            definition: { discountId: 'whole-discount:776', revision: { revisionId: 'whole-r776' } },
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
  },
);

const subjectEvidence = {
  evidenceRef: 'commerce-subject:guest-776',
  observedAt: operationTime,
  ownerModuleId: 'commerce.customer-context',
  ownerRevision: 'commerce-subject-r776',
  provenanceRef: 'commerce-subject-proof:776',
  revalidatedAt: operationTime,
  subject: { guestEvidenceRef: 'guest-session:776', kind: 'GUEST' as const, tenantId },
};
const currencyCompatibility = {
  currencyCode: 'CZK' as const,
  evidenceRef: 'pricing-currency-support:776',
  observedAt: operationTime,
  ownerRevision: 'pricing-currency-support-r776',
  status: 'SUPPORTED_CURRENT' as const,
  tenantId,
};
const makeInput = (
  pricingComposition: PricingPromotionCompositionInput['pricingComposition'],
): PricingPromotionCompositionInput => ({
  applicationRequestRef: 'voucher-request:776',
  candidateRef: 'pricing-candidate:776',
  currencyCompatibility,
  decision,
  exactPredicateRef: 'promotion-contribution:pricing-candidate:776',
  pricingComposition,
  pricingCompositionRef: 'pricing-composition:776',
  pricingCompositionRevision: 'pricing-composition-r776',
  subjectEvidence,
});
const ownerEvidence = (request: PromotionContributionRequest) => ({
  completenessEvidence: {
    nextApplicabilityBoundary: '2026-09-28T08:01:00.000Z',
    observedAt: operationTime,
    ownerRevision: 'promotion-current-r776',
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
  ownerRevision: 'promotion-current-r776',
  provenanceRef: 'promotion-proof:776',
});
const applicationIdentity = (request: PromotionContributionRequest) => ({
  applicationKind: 'PROMOTION_APPLICATION' as const,
  applicationRef: 'voucher-application:776',
  applicationRevision: 'voucher-application-r776',
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
      ? [{ amount: money('-20'), deliveryComponentRef: 'delivery-component:776', recipientKind: 'SHIPPING' as const }]
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
          shippingComponentRefs: ['delivery-component:776'],
        }
      : { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a', 'line-b'] },
});
const source = (
  evaluate: (request: PromotionContributionRequest) => PromotionContributionOutcome,
): PromotionContributionSourcePort => ({ evaluate: (request) => Effect.succeed(evaluate(request)) });
const expectFailure = Effect.fn('test.expectIssue776PromotionFailure')(function* expectIssue776PromotionFailure(
  input: PricingPromotionCompositionInput,
  ownerSource: PromotionContributionSourcePort,
  expected: (failure: PricingPromotionCompositionFailure) => boolean,
) {
  const failure = yield* Effect.flip(makePricingPromotionCompositionService(ownerSource).compose(input));
  expect(expected(failure), failure._tag).toBe(true);
});

describe('issue #776 Pricing Promotion composition acceptance', () => {
  it.effect(
    'composes independent Group and Counterparty line layers, one whole-purchase benefit, then owner allocations exactly once',
    () =>
      Effect.gen(function* appliesExactOrderOnce() {
        const pricingComposition = yield* makePostPricingComposition();
        expect(
          pricingComposition.lineIntermediates.map(({ lineDiscountContributions }) => lineDiscountContributions),
        ).toEqual([
          [expect.objectContaining({ amount: money('-60') }), expect.objectContaining({ amount: money('-40') })],
          [expect.objectContaining({ amount: money('-15') }), expect.objectContaining({ amount: money('-10') })],
        ]);
        expect(
          pricingComposition.composedLines.map(({ rawPostAllocationValue }) => rawPostAllocationValue.amount),
        ).toEqual(['800', '200']);

        const seenRequests: PromotionContributionRequest[] = [];
        const result = yield* makePricingPromotionCompositionService(
          source((request) => {
            seenRequests.push(request);
            return appliedOutcome(request);
          }),
        ).compose(makeInput(pricingComposition));

        expect(seenRequests).toHaveLength(1);
        expect(seenRequests[0]?.prePromotionBasis.lines.map(({ amount }) => amount.amount)).toEqual(['800', '200']);
        expect(result.lines.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-a', 'line-b']);
        expect(result.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);
        expect(result.lines.reduce((sum, lineResult) => sum + Number(lineResult.rawPreTaxValue.amount), 0)).toBe(900);
        expect(result.request.prePromotionBasis.completedPricingAllocationRefs).toEqual(
          expect.arrayContaining([
            'pricing-composition:776',
            'commerce.pricing:group-discount:line-a:group-discount-r776:line-a',
            'commerce.pricing:counterparty-discount:line-a:counterparty-discount-r776:line-a',
            'commerce.pricing:group-discount:line-b:group-discount-r776:line-b',
            'commerce.pricing:counterparty-discount:line-b:counterparty-discount-r776:line-b',
            'commerce.pricing:whole-discount:776:whole-r776',
          ]),
        );
      }),
  );

  it.effect(
    'is Storefront-independent while exact Tenant, seller, Channel, Market, subject, currency, and basis remain bound',
    () =>
      Effect.gen(function* provesBackendIdentityOnly() {
        const input = makeInput(yield* makePostPricingComposition());
        const seenRequests: PromotionContributionRequest[] = [];
        const service = makePricingPromotionCompositionService(
          source((request) => {
            seenRequests.push(request);
            return appliedOutcome(request);
          }),
        );

        const storefrontAInput = { ...input, storefrontAppId: 'storefront-a' };
        const storefrontBInput = { ...input, storefrontAppId: 'storefront-b' };
        const first = yield* service.compose(storefrontAInput);
        const second = yield* service.compose(storefrontBInput);
        expect(first.lines).toEqual(second.lines);
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(seenRequests)).not.toContain(
          'storefront',
        );

        const mismatches: readonly PricingPromotionCompositionInput[] = [
          {
            ...input,
            decision: {
              ...input.decision,
              commercialScope: {
                ...input.decision.commercialScope,
                sellingLegalEntityId: '77777777-7777-4777-8777-777777777777',
              },
            },
          },
          {
            ...input,
            decision: {
              ...input.decision,
              commercialScope: { ...input.decision.commercialScope, channelId: 'B2B' },
            },
          },
          {
            ...input,
            decision: {
              ...input.decision,
              commercialScope: { ...input.decision.commercialScope, marketId: 'another-market' },
            },
          },
          { ...input, currencyCompatibility: { ...input.currencyCompatibility, currencyCode: 'EUR' } },
        ];
        for (const mismatch of mismatches) {
          yield* expectFailure(mismatch, source(appliedOutcome), Schema.is(PricingPromotionUnverifiable));
        }
        yield* expectFailure(
          input,
          source((request) => ({
            ...appliedOutcome(request),
            request: {
              ...request,
              subjectEvidence: {
                ...request.subjectEvidence,
                subject: { ...request.subjectEvidence.subject, guestEvidenceRef: 'another-guest' },
              },
            },
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
      }),
  );

  it.effect('retains Shipping only when owner-explicit and never subtracts that component from Pricing lines', () =>
    Effect.gen(function* retainsDeliveryOwnership() {
      const input = makeInput(yield* makePostPricingComposition());
      const ordinary = yield* makePricingPromotionCompositionService(source(appliedOutcome)).compose(input);
      expect(ordinary.shippingAllocations).toEqual([]);
      expect(ordinary.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);

      const explicit = yield* makePricingPromotionCompositionService(
        source((request) => appliedOutcome(request, { shipping: true })),
      ).compose(input);
      expect(explicit.shippingAllocations).toEqual([
        { amount: money('-20'), deliveryComponentRef: 'delivery-component:776', recipientKind: 'SHIPPING' },
      ]);
      expect(explicit.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['720', '180']);
    }),
  );

  it.effect(
    'fails typed instead of equal-splitting, clamping, silently dropping, or double-applying malformed owner input',
    () =>
      Effect.gen(function* rejectsOwnerSubstitution() {
        const input = makeInput(yield* makePostPricingComposition());
        yield* expectFailure(
          input,
          source((request) => ({ ...appliedOutcome(request), contribution: money('-101') })),
          (failure) => Schema.is(PricingPromotionConflict)(failure) || Schema.is(PricingPromotionUnverifiable)(failure),
        );
        yield* expectFailure(
          input,
          source((request) => ({
            ...appliedOutcome(request),
            allocations: [
              {
                amount: money('-100'),
                catalogSelection: selection('a'),
                occurrenceId: 'line-a',
                recipientKind: 'MERCHANDISE',
              },
            ],
          })),
          (failure) => Schema.is(PricingPromotionConflict)(failure) || Schema.is(PricingPromotionUnverifiable)(failure),
        );
        yield* expectFailure(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_INVALID',
            reason: 'CANDIDATE_BINDING_MISMATCH',
            request,
            retryable: false,
          })),
          Schema.is(PricingPromotionInputInvalid),
        );
        yield* expectFailure(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_CONFLICT',
            conflictingApplicationRefs: ['application-a', 'application-b'],
            reason: 'MULTIPLE_AUTHORITATIVE_CONTRIBUTIONS',
            request,
            retryable: false,
          })),
          Schema.is(PricingPromotionConflict),
        );
        yield* expectFailure(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_UNAVAILABLE',
            reason: 'OWNER_UNAVAILABLE',
            request,
            retryable: true,
          })),
          Schema.is(PricingPromotionUnavailable),
        );
        yield* expectFailure(
          input,
          source((request) => ({
            _tag: 'PROMOTION_CONTRIBUTION_UNVERIFIABLE',
            missingEvidenceRefs: ['promotion-proof:776'],
            reason: 'EVIDENCE_INCOMPLETE',
            request,
            retryable: true,
          })),
          Schema.is(PricingPromotionUnverifiable),
        );
      }),
  );

  it.effect(
    'keeps zero and non-positive Voucher basis parked and proves no Pricing provider or eligibility fallback',
    () =>
      Effect.gen(function* keepsOwnerEdgeParked() {
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
        yield* expectFailure(
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
        yield* expectFailure(input, source(appliedOutcome), Schema.is(PricingPromotionUnverifiable));
      }),
  );

  it.effect('accepts exact Current owner evidence and preserves the proof from the accepted fresh attempt', () =>
    Effect.gen(function* acceptsOneCurrentAttempt() {
      const input = makeInput(yield* makePostPricingComposition());
      const composition = makePricingPromotionCompositionService(source(appliedOutcome));
      const current = makePricingPromotionCurrentEvaluationService(composition.compose, {
        revalidate: ({ expectedOwnerEvidence }) =>
          Effect.succeed({ _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT' as const, ownerEvidence: expectedOwnerEvidence }),
      });
      const attempts: number[] = [];
      const result = yield* current.evaluate({
        loadFresh: (attempt) => {
          attempts.push(attempt);
          return Effect.succeed(input);
        },
      });

      expect(attempts).toEqual([1]);
      expect(result.attempts).toBe(1);
      expect(result.currentnessEvidence).toEqual(result.composition.ownerDecision.ownerEvidence);
      expect(result.composition.request.candidate.decision.commercialScope).toEqual(decision.commercialScope);
      expect(result.composition.request.subjectEvidence).toEqual(subjectEvidence);
      expect(result.composition.request.currencyCompatibility).toEqual(currencyCompatibility);
    }),
  );

  it.effect('discards a changed attempt whole, retries once from fresh input, and never merges old evidence', () =>
    Effect.gen(function* retriesWholeAttemptOnly() {
      const input = makeInput(yield* makePostPricingComposition());
      const composition = makePricingPromotionCompositionService(source(appliedOutcome));
      const seenCandidates: string[] = [];
      let probeCalls = 0;
      const current = makePricingPromotionCurrentEvaluationService(composition.compose, {
        revalidate: ({ expectedOwnerEvidence, request }) => {
          probeCalls += 1;
          seenCandidates.push(request.candidate.candidateRef);
          return Effect.succeed(
            probeCalls === 1
              ? {
                  _tag: 'PROMOTION_OWNER_EVIDENCE_CHANGED' as const,
                  ownerEvidence: {
                    ...expectedOwnerEvidence,
                    completenessEvidence: {
                      ...expectedOwnerEvidence.completenessEvidence,
                      ownerRevision: 'promotion-changed-r776',
                    },
                    ownerRevision: 'promotion-changed-r776',
                    provenanceRef: 'promotion-changed-proof:776',
                  },
                }
              : { _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT' as const, ownerEvidence: expectedOwnerEvidence },
          );
        },
      });
      const result = yield* current.evaluate({
        loadFresh: (attempt) => Effect.succeed({ ...input, candidateRef: `pricing-candidate:776:attempt-${attempt}` }),
      });

      expect(seenCandidates).toEqual(['pricing-candidate:776:attempt-1', 'pricing-candidate:776:attempt-2']);
      expect(result.attempts).toBe(2);
      expect(result.composition.request.candidate.candidateRef).toBe('pricing-candidate:776:attempt-2');
      expect(result.currentnessEvidence.ownerRevision).toBe('promotion-current-r776');
      expect(result.currentnessEvidence.provenanceRef).toBe('promotion-proof:776');
    }),
  );

  it.effect('fails typed after two mismatched CURRENT proofs instead of accepting a revision string or looping', () =>
    Effect.gen(function* boundsCurrentnessRetry() {
      const input = makeInput(yield* makePostPricingComposition());
      const composition = makePricingPromotionCompositionService(source(appliedOutcome));
      const attempts: number[] = [];
      const current = makePricingPromotionCurrentEvaluationService(composition.compose, {
        revalidate: ({ expectedOwnerEvidence }) =>
          Effect.succeed({
            _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT' as const,
            ownerEvidence: {
              ...expectedOwnerEvidence,
              completenessEvidence: {
                ...expectedOwnerEvidence.completenessEvidence,
                ownerRevision: 'promotion-other-r776',
              },
              ownerRevision: 'promotion-other-r776',
              provenanceRef: 'promotion-other-proof:776',
            },
          }),
      });
      const failure = yield* Effect.flip(
        current.evaluate({
          loadFresh: (attempt) => {
            attempts.push(attempt);
            return Effect.succeed(input);
          },
        }),
      );

      expect(attempts).toEqual([1, 2]);
      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
    }),
  );
});
