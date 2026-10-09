import type { PricingCommercialTotalRequest } from '@app/pricing-contracts/domain/commercial-total';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import {
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
} from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingFinalPreRoundReady } from '@app/pricing-contracts/domain/line-composition';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { assessWholePurchaseDiscountThreshold } from '../../src/services/discount-applicability.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import {
  candidateRef,
  makeIssue779PreRoundScenario,
  money,
  occurrenceId,
} from './support/issue-779-line-value.fixture.ts';

const selectedPromotionComposition = (preRound: PricingFinalPreRoundReady) => {
  const selection = preRound.rawComposition.promotionComposition;
  if (selection.kind !== 'PROMOTION_SELECTED') {
    throw new Error('Issue #780 fixture requires selected Promotion evidence');
  }
  return selection.composition;
};

const requestFor = (
  preRound: PricingCommercialTotalRequest['preRound'],
  publishedAmount: string,
  roundingAdjustment = '0',
  currencyCode = 'CZK',
): PricingCommercialTotalRequest => ({
  candidateRef,
  decision: preRound.decision,
  preRound,
  publishedLines: [
    {
      occurrenceId,
      publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
      publishedLineValue: money(publishedAmount, currencyCode),
      roundingAdjustment: money(roundingAdjustment, currencyCode),
    },
  ],
});

const mergePreRoundLines = (
  first: PricingFinalPreRoundReady,
  second: PricingFinalPreRoundReady,
): PricingFinalPreRoundReady => {
  const [firstDecisionLine] = first.decision.lines;
  const [secondDecisionLine] = second.decision.lines;
  const [firstPreRoundLine] = first.lines;
  const [secondPreRoundLine] = second.lines;
  const [firstRawLine] = first.rawComposition.lines;
  const [secondRawLine] = second.rawComposition.lines;
  const firstPromotion = selectedPromotionComposition(first);
  const secondPromotion = selectedPromotionComposition(second);
  const [firstPromotionLine] = firstPromotion.lines;
  const [secondPromotionLine] = secondPromotion.lines;
  if (
    firstDecisionLine === undefined ||
    secondDecisionLine === undefined ||
    firstPreRoundLine === undefined ||
    secondPreRoundLine === undefined ||
    firstRawLine === undefined ||
    secondRawLine === undefined ||
    firstPromotionLine === undefined ||
    secondPromotionLine === undefined
  ) {
    throw new Error('Issue #780 multi-line fixture requires two complete original Pricing lines');
  }
  const decision = { ...first.decision, lines: [firstDecisionLine, secondDecisionLine] };
  const firstBoundRaw = {
    ...firstRawLine,
    feeCalculation: {
      ...firstRawLine.feeCalculation,
      input: { ...firstRawLine.feeCalculation.input, decision },
    },
  };
  const secondBoundRaw = {
    ...secondRawLine,
    feeCalculation: {
      ...secondRawLine.feeCalculation,
      input: { ...secondRawLine.feeCalculation.input, decision },
    },
  };
  const promotionComposition = {
    composition: {
      ...firstPromotion,
      decision,
      lines: [firstPromotionLine, secondPromotionLine],
    },
    kind: 'PROMOTION_SELECTED' as const,
  };
  return {
    ...first,
    decision,
    lines: [
      { ...firstPreRoundLine, composition: firstBoundRaw },
      { ...secondPreRoundLine, composition: secondBoundRaw },
    ],
    rawComposition: {
      ...first.rawComposition,
      decision,
      lines: [firstBoundRaw, secondBoundRaw],
      promotionComposition,
    },
  };
};

const requestForPublishedLines = (
  preRound: PricingFinalPreRoundReady,
  published: readonly {
    readonly amount: string;
    readonly currencyCode?: string;
    readonly occurrenceId: string;
    readonly roundingAdjustment: string;
  }[],
): PricingCommercialTotalRequest => ({
  candidateRef,
  decision: preRound.decision,
  preRound,
  publishedLines: published.map((line) => ({
    occurrenceId: line.occurrenceId,
    publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
    publishedLineValue: money(line.amount, line.currencyCode),
    roundingAdjustment: money(line.roundingAdjustment, line.currencyCode),
  })),
});

const assessThresholdAt = (basis: string) =>
  assessWholePurchaseDiscountThreshold({
    configuredAmount: money('100'),
    decisionCurrencyCode: 'CZK',
    intermediates: [{ amount: money(basis), occurrenceId, recipientKind: 'MERCHANDISE' }],
  });

describe('issue #780 Pricing commercial totals acceptance', () => {
  it.effect('reconciles Fee, fixed line benefits, and Promotion allocation exactly once', () =>
    Effect.gen(function* reconcilesExactComponents() {
      const { preRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['10', '10', '10'],
        feeAmount: '10',
        promotionAmount: '-10',
      });
      const result = yield* calculatePricingCommercialTotals(requestFor(preRound, '70'));

      expect(result).toMatchObject({
        breakdown: {
          baseLineTotal: money('100'),
          commercialFeeTotal: money('10'),
          pricingLineRoundingAdjustmentTotal: money('0'),
          pricingOwnedDiscountTotal: money('-30'),
          promotionAllocationTotal: money('-10'),
          zeroFloorAdjustmentTotal: money('0'),
        },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('70'),
      });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(selectedPromotionComposition(result.sourceEvidence.preRound).promotion).toMatchObject({
        contribution: money('-10'),
        outcome: 'PROMOTION_APPLIED',
      });
      expect(result.pricingNetCommercialTotal.amount).not.toBe('60');
      expect(result.calculationVersions).toEqual({
        allocationContractVersions: [PRICING_ALLOCATION_PROFILE_VERSION],
        arithmeticProfileVersions: [PRICING_ARITHMETIC_PROFILE_VERSION],
        publicationProfileVersions: [PRICING_CZK_PUBLICATION_PROFILE_VERSION],
      });
      expect(result.publishedLines.map(({ occurrenceId: stableOccurrence }) => stableOccurrence)).toEqual([
        occurrenceId,
      ]);
    }),
  );

  it.effect('publishes an ordinary whole-candidate Result without fabricating Promotion evidence', () =>
    Effect.gen(function* publishesWithoutPromotionSelection() {
      const { preRound: selected } = yield* makeIssue779PreRoundScenario({
        discounts: ['5', '10', '15'],
        feeAmount: '10',
      });
      const preRound: PricingFinalPreRoundReady = {
        ...selected,
        rawComposition: {
          ...selected.rawComposition,
          promotionComposition: { kind: 'PROMOTION_NOT_SELECTED' },
        },
      };
      const result = yield* calculatePricingCommercialTotals(requestFor(preRound, '80'));

      expect(result).toMatchObject({
        breakdown: {
          baseLineTotal: money('100'),
          commercialFeeTotal: money('10'),
          pricingOwnedDiscountTotal: money('-30'),
          promotionAllocationTotal: money('0'),
        },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('80'),
        sourceEvidence: {
          preRound: { rawComposition: { promotionComposition: { kind: 'PROMOTION_NOT_SELECTED' } } },
        },
      });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      const contributions = result.sourceEvidence.preRound.lines[0]?.composition.lineDiscountContributions;
      expect(
        contributions?.map(({ amount, candidate }) => ({
          amount,
          audience: candidate.definition.identityKey.audience.kind,
          configuredLevel: candidate.definition.revision.configuredEffect.level,
          discountId: candidate.definition.discountId,
          effect: candidate.definition.identityKey.effectKind,
          family: candidate.definition.identityKey.family,
          layer: candidate.layer,
          revisionId: candidate.definition.revision.revisionId,
          scope: candidate.definition.identityKey.scope,
        })),
      ).toEqual([
        expect.objectContaining({
          amount: money('-5'),
          audience: 'CATALOG_PATH',
          configuredLevel: money('5'),
          effect: 'FIXED_MONETARY_AMOUNT',
          family: 'CATALOG_DISCOUNT',
          layer: 'CATALOG',
          scope: 'VARIANT_LINE',
        }),
        expect.objectContaining({
          amount: money('-10'),
          audience: 'PRICE_GROUP',
          configuredLevel: money('10'),
          effect: 'FIXED_MONETARY_AMOUNT',
          family: 'CONTRACTUAL_DISCOUNT',
          layer: 'PRICE_GROUP_CONTRACTUAL',
          scope: 'VARIANT_LINE',
        }),
        expect.objectContaining({
          amount: money('-15'),
          audience: 'COUNTERPARTY',
          configuredLevel: money('15'),
          effect: 'FIXED_MONETARY_AMOUNT',
          family: 'CONTRACTUAL_DISCOUNT',
          layer: 'COUNTERPARTY_CONTRACTUAL',
          scope: 'VARIANT_LINE',
        }),
      ]);
    }),
  );

  it.effect('retains independent percentage/fixed evidence and applies ZERO_FLOOR once', () =>
    Effect.gen(function* retainsEvidenceAndFloor() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['40', '40', '40'] });
      const result = yield* calculatePricingCommercialTotals(requestFor(preRound, '0'));

      expect(result).toMatchObject({
        breakdown: {
          baseLineTotal: money('100'),
          commercialFeeTotal: money('0'),
          pricingOwnedDiscountTotal: money('-120'),
          promotionAllocationTotal: money('0'),
          zeroFloorAdjustmentTotal: money('20'),
        },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('0'),
      });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(result.sourceEvidence.preRound.lines[0]?.floorEvaluation).toMatchObject({
        floorAdjustment: money('20'),
        kind: 'AUTHORIZED_ZERO_FLOOR',
        rawPostCompositionValue: money('-20'),
      });
      expect(result.sourceEvidence.preRound.lines[0]?.composition.lineDiscountContributions).toHaveLength(3);
    }),
  );

  it.effect('rejects fabricated floor, Promotion, and whole-purchase evidence drift', () =>
    Effect.gen(function* rejectsOwnerEvidenceDrift() {
      const { preRound: floored } = yield* makeIssue779PreRoundScenario({ discounts: ['40', '40', '40'] });
      const [flooredLine] = floored.lines;
      if (flooredLine === undefined || flooredLine.floorEvaluation.kind !== 'AUTHORIZED_ZERO_FLOOR') {
        throw new Error('Issue #780 drift fixture requires an authorized ZERO_FLOOR line');
      }
      const fabricatedFloor: PricingFinalPreRoundReady = {
        ...floored,
        lines: [
          {
            ...flooredLine,
            floorEvaluation: {
              ...flooredLine.floorEvaluation,
              floorAdjustment: money('30'),
            },
            nonNegativePreRoundValue: money('10'),
          },
        ],
      };
      expect(yield* calculatePricingCommercialTotals(requestFor(fabricatedFloor, '10'))).toMatchObject({
        outcome: 'COMMERCIAL_TOTAL_FAILED',
      });

      const { preRound: promoted } = yield* makeIssue779PreRoundScenario({
        priceAmount: '800',
        promotionAmount: '-80',
      });
      const [promotedLine] = promoted.lines;
      const [promotedRawLine] = promoted.rawComposition.lines;
      if (
        promotedLine === undefined ||
        promotedRawLine === undefined ||
        promotedRawLine.promotionAllocation === undefined
      ) {
        throw new Error('Issue #780 drift fixture requires an applied Promotion allocation');
      }
      const promotionDrift = {
        ...promotedRawLine,
        promotionAllocation: { ...promotedRawLine.promotionAllocation, amount: money('-180') },
      };
      const fabricatedPromotion: PricingFinalPreRoundReady = {
        ...promoted,
        lines: [{ ...promotedLine, composition: promotionDrift }],
        rawComposition: { ...promoted.rawComposition, lines: [promotionDrift] },
      };
      expect(yield* calculatePricingCommercialTotals(requestFor(fabricatedPromotion, '720'))).toMatchObject({
        outcome: 'COMMERCIAL_TOTAL_FAILED',
      });

      const { preRound: unallocated } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      const [unallocatedLine] = unallocated.lines;
      const [unallocatedRawLine] = unallocated.rawComposition.lines;
      if (unallocatedLine === undefined || unallocatedRawLine === undefined) {
        throw new Error('Issue #780 drift fixture requires one complete original line');
      }
      const wholePurchaseDrift = {
        ...unallocatedRawLine,
        wholePurchaseAllocation: {
          amount: money('-1'),
          occurrenceId,
          recipientKind: 'MERCHANDISE' as const,
        },
        wholePurchaseAllocationRevisionRef: 'whole-discount:unverified',
      };
      const fabricatedWholePurchase: PricingFinalPreRoundReady = {
        ...unallocated,
        lines: [{ ...unallocatedLine, composition: wholePurchaseDrift }],
        rawComposition: { ...unallocated.rawComposition, lines: [wholePurchaseDrift] },
      };
      expect(yield* calculatePricingCommercialTotals(requestFor(fabricatedWholePurchase, '100'))).toMatchObject({
        outcome: 'COMMERCIAL_TOTAL_FAILED',
      });
    }),
  );

  it.effect('keeps strict B > D applicability before total aggregation', () =>
    Effect.gen(function* preservesStrictThreshold() {
      expect(yield* assessThresholdAt('99')).toMatchObject({ outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE' });
      expect(yield* assessThresholdAt('100')).toMatchObject({ outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE' });
      expect(yield* assessThresholdAt('100.0001')).toMatchObject({
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        contribution: money('-100'),
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      });
    }),
  );

  it.effect('retains B<D and B=D evidence as known non-applicability in the canonical Result', () =>
    Effect.gen(function* retainsWholePurchaseNonApplicability() {
      const { preRound: base } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      for (const configuredDiscount of ['101', '100']) {
        const allocation = yield* allocatePricingDiscountsAndFees({
          allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE',
          configuredDiscount: money(configuredDiscount),
          decision: base.decision,
          eligibleBasis: {
            currencyCode: 'CZK',
            eligibleAmount: '100',
            recipients: [{ intermediateValue: money('100'), occurrenceId, recipientKind: 'MERCHANDISE' }],
          },
          reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
          source: {
            allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
            logicalFactRef: 'whole-discount:780',
            ownerModuleId: 'commerce.pricing',
            revisionRef: 'whole-discount-revision:780',
            sourceKind: 'PRICING_DISCOUNT',
          },
        });
        expect(allocation.outcome).toBe('ALLOCATION_NOT_APPLICABLE');
        if (allocation.outcome !== 'ALLOCATION_NOT_APPLICABLE') {
          return;
        }
        const preRound: PricingFinalPreRoundReady = {
          ...base,
          rawComposition: { ...base.rawComposition, wholePurchaseAllocationEvidence: allocation },
        };
        const result = yield* calculatePricingCommercialTotals(requestFor(preRound, '100'));
        expect(result).toMatchObject({
          outcome: 'COMMERCIAL_TOTAL_READY',
          sourceEvidence: {
            preRound: {
              rawComposition: {
                wholePurchaseAllocationEvidence: {
                  outcome: 'ALLOCATION_NOT_APPLICABLE',
                  request: {
                    configuredDiscount: money(configuredDiscount),
                    eligibleBasis: { eligibleAmount: '100' },
                    reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
                  },
                },
              },
            },
          },
        });
      }
    }),
  );

  it.effect('sums already-published stable lines without independently rounding their exact candidate total', () =>
    Effect.gen(function* sumsOnlyPublishedLines() {
      const first = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-a',
        priceAmount: '33.335',
      });
      const second = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-b',
        priceAmount: '66.665',
      });
      const preRound = mergePreRoundLines(first.preRound, second.preRound);
      const result = yield* calculatePricingCommercialTotals(
        requestForPublishedLines(preRound, [
          { amount: '33.34', occurrenceId: 'line-780-a', roundingAdjustment: '0.005' },
          { amount: '66.67', occurrenceId: 'line-780-b', roundingAdjustment: '0.005' },
        ]),
      );

      expect(result).toMatchObject({
        breakdown: {
          baseLineTotal: money('100'),
          pricingLineRoundingAdjustmentTotal: money('0.01'),
        },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('100.01'),
      });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(result.pricingNetCommercialTotal.amount).not.toBe('100');
      expect(result.publishedLines.map(({ occurrenceId: stableOccurrence }) => stableOccurrence)).toEqual([
        'line-780-a',
        'line-780-b',
      ]);
    }),
  );

  it.effect('retains one owner Promotion contribution through its 800/200 allocations without re-deduction', () =>
    Effect.gen(function* preservesPromotionAllocationOnce() {
      const first = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-promotion-a',
        priceAmount: '800',
        promotionAmount: '-80',
      });
      const second = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-promotion-b',
        priceAmount: '200',
        promotionAmount: '-20',
      });
      const merged = mergePreRoundLines(first.preRound, second.preRound);
      const mergedPromotion = selectedPromotionComposition(merged);
      const firstPromotion = selectedPromotionComposition(first.preRound).promotion;
      const secondPromotion = selectedPromotionComposition(second.preRound).promotion;
      if (firstPromotion.outcome !== 'PROMOTION_APPLIED' || secondPromotion.outcome !== 'PROMOTION_APPLIED') {
        throw new Error('Issue #780 fixture requires two applied owner Promotion allocations');
      }
      const promotionComposition = {
        composition: {
          ...mergedPromotion,
          promotion: {
            ...firstPromotion,
            allocations: [...firstPromotion.allocations, ...secondPromotion.allocations],
            contribution: money('-100'),
            target: {
              kind: 'MERCHANDISE_ONLY' as const,
              occurrenceIds: ['line-780-promotion-a', 'line-780-promotion-b'],
            },
          },
        },
        kind: 'PROMOTION_SELECTED' as const,
      };
      const preRound: PricingFinalPreRoundReady = {
        ...merged,
        rawComposition: { ...merged.rawComposition, promotionComposition },
      };
      const result = yield* calculatePricingCommercialTotals(
        requestForPublishedLines(preRound, [
          { amount: '720', occurrenceId: 'line-780-promotion-a', roundingAdjustment: '0' },
          { amount: '180', occurrenceId: 'line-780-promotion-b', roundingAdjustment: '0' },
        ]),
      );

      expect(result).toMatchObject({
        breakdown: { baseLineTotal: money('1000'), promotionAllocationTotal: money('-100') },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('900'),
      });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(selectedPromotionComposition(result.sourceEvidence.preRound).promotion).toMatchObject({
        allocations: [
          { amount: money('-80'), occurrenceId: 'line-780-promotion-a' },
          { amount: money('-20'), occurrenceId: 'line-780-promotion-b' },
        ],
        contribution: money('-100'),
      });
      expect(result.pricingNetCommercialTotal.amount).not.toBe('800');
    }),
  );

  it.effect('preserves sub-cent whole-purchase allocation sum and capacity without floor repair', () =>
    Effect.gen(function* preservesSubCentAllocation() {
      const first = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-allocation-a',
        priceAmount: '9.7097',
      });
      const second = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-780-allocation-b',
        priceAmount: '90.2975',
      });
      const merged = mergePreRoundLines(first.preRound, second.preRound);
      const allocation = yield* allocatePricingDiscountsAndFees({
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
        decision: merged.decision,
        eligibleBasis: {
          currencyCode: 'CZK',
          eligibleAmount: '100.0072',
          recipients: [
            {
              intermediateValue: money('9.7097'),
              occurrenceId: 'line-780-allocation-a',
              recipientKind: 'MERCHANDISE',
            },
            {
              intermediateValue: money('90.2975'),
              occurrenceId: 'line-780-allocation-b',
              recipientKind: 'MERCHANDISE',
            },
          ],
        },
        originalContribution: money('-100'),
        precision: {
          allocationScale: 18,
          amountPrecision: 76,
          contractVersion: 'pricing-allocation-v1',
          remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
        },
        source: {
          allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
          logicalFactRef: 'whole-discount:780',
          ownerModuleId: 'commerce.pricing',
          revisionRef: 'whole-discount-r780',
          sourceKind: 'PRICING_DISCOUNT',
        },
      });
      if (allocation.outcome !== 'ALLOCATION_APPLIED') {
        throw new Error('Issue #780 fixture requires exact capacity-preserving allocation');
      }

      expect(allocation.allocations).toMatchObject([
        { amount: money('-9.709000951931460935'), occurrenceId: 'line-780-allocation-a' },
        { amount: money('-90.290999048068539065'), occurrenceId: 'line-780-allocation-b' },
      ]);
      expect(merged.lines.map(({ floorEvaluation }) => floorEvaluation.floorAdjustment)).toEqual([
        money('0'),
        money('0'),
      ]);

      const postAllocationAmounts = ['0.000699048068539065', '0.006500951931460935'] as const;
      const allocationByOccurrence = new Map(allocation.allocations.map((line) => [line.occurrenceId, line] as const));
      const boundRawLines = merged.rawComposition.lines.map((line, index) => {
        const retainedAllocation = allocationByOccurrence.get(line.occurrenceId);
        if (retainedAllocation === undefined) {
          throw new Error('Issue #780 allocation result fixture requires one allocation per original occurrence');
        }
        return {
          ...line,
          prePromotionValue: money(postAllocationAmounts[index] ?? '0'),
          rawPostCompositionValue: money(postAllocationAmounts[index] ?? '0'),
          wholePurchaseAllocation: retainedAllocation,
          wholePurchaseAllocationRevisionRef: allocation.request.source.revisionRef,
        };
      });
      const promotionSelection = merged.rawComposition.promotionComposition;
      if (promotionSelection.kind !== 'PROMOTION_SELECTED') {
        throw new Error('Issue #780 allocation result fixture requires selected Promotion evaluation');
      }
      const retainedPreRound: PricingFinalPreRoundReady = {
        ...merged,
        lines: merged.lines.map((line, index) => {
          if (line.floorEvaluation.kind !== 'NOT_REQUIRED') {
            throw new Error('Issue #780 allocation result fixture requires an ordinary nonnegative line');
          }
          const value = money(postAllocationAmounts[index] ?? '0');
          return {
            ...line,
            composition: boundRawLines[index] ?? line.composition,
            floorEvaluation: {
              ...line.floorEvaluation,
              nonNegativePreRoundValue: value,
              rawPostCompositionValue: value,
            },
            nonNegativePreRoundValue: value,
          };
        }),
        rawComposition: {
          ...merged.rawComposition,
          lines: boundRawLines,
          promotionComposition: {
            ...promotionSelection,
            composition: {
              ...promotionSelection.composition,
              lines: promotionSelection.composition.lines.map((line, index) => ({
                ...line,
                prePromotionValue: money(postAllocationAmounts[index] ?? '0'),
                rawPreTaxValue: money(postAllocationAmounts[index] ?? '0'),
              })),
            },
          },
          wholePurchaseAllocationEvidence: allocation,
        },
      };
      const result = yield* calculatePricingCommercialTotals(
        requestForPublishedLines(retainedPreRound, [
          {
            amount: '0',
            occurrenceId: 'line-780-allocation-a',
            roundingAdjustment: '-0.000699048068539065',
          },
          {
            amount: '0',
            occurrenceId: 'line-780-allocation-b',
            roundingAdjustment: '-0.006500951931460935',
          },
        ]),
      );
      expect(result).toMatchObject({ outcome: 'COMMERCIAL_TOTAL_READY' });
      if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(result.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence).toEqual(allocation);
      expect(result.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence).toMatchObject({
        allocations: allocation.allocations,
        outcome: 'ALLOCATION_APPLIED',
        request: {
          eligibleBasis: {
            eligibleAmount: '100.0072',
            recipients: [
              { intermediateValue: money('9.7097'), occurrenceId: 'line-780-allocation-a' },
              { intermediateValue: money('90.2975'), occurrenceId: 'line-780-allocation-b' },
            ],
          },
          precision: {
            allocationScale: 18,
            amountPrecision: 76,
            remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
          },
        },
      });
    }),
  );

  it.effect('fails closed on mixed currency and represents EUR without activating a publication profile', () =>
    Effect.gen(function* preservesGeneralCurrencyContracts() {
      expect(yield* Schema.decodeEffect(PricingCurrencyCodeSchema)('EUR')).toBe('EUR');

      const { preRound: czkPreRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
      });
      expect(yield* calculatePricingCommercialTotals(requestFor(czkPreRound, '100', '0', 'EUR'))).toMatchObject({
        failure: { code: 'CURRENCY_MISMATCH' },
        outcome: 'COMMERCIAL_TOTAL_FAILED',
      });

      const { preRound: eurPreRound } = yield* makeIssue779PreRoundScenario({
        currencyCode: 'EUR',
        discounts: ['0', '0', '0'],
      });
      expect(yield* calculatePricingCommercialTotals(requestFor(eurPreRound, '100', '0', 'EUR'))).toMatchObject({
        failure: { code: 'PRECISION_MISMATCH' },
        outcome: 'COMMERCIAL_TOTAL_FAILED',
      });
    }),
  );

  it.effect('publishes only Pricing pre-Tax components and never downstream totals', () =>
    Effect.gen(function* excludesDownstreamOwnership() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      const result = yield* calculatePricingCommercialTotals(requestFor(preRound, '100'));

      expect(result.outcome).toBe('COMMERCIAL_TOTAL_READY');
      expect('shippingTotal' in result).toBe(false);
      expect('deliveryTotal' in result).toBe(false);
      expect('taxTotal' in result).toBe(false);
      expect('grossTotal' in result).toBe(false);
      expect('finalPayableTotal' in result).toBe(false);
      expect('storefrontId' in result).toBe(false);
      expect('fxRate' in result).toBe(false);
    }),
  );
});
