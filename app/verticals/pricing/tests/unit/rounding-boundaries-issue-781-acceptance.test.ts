import type { PricingCommercialTotalRequest } from '@app/pricing-contracts/domain/commercial-total';
import {
  addPricingExactDecimals,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
} from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingFinalPreRoundReady } from '@app/pricing-contracts/domain/line-composition';
import type { PricingLinePublicationRequest } from '@app/pricing-contracts/domain/rounding-boundary';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  const firstPromotion = first.rawComposition.promotionComposition;
  const secondPromotion = second.rawComposition.promotionComposition;
  const [firstPromotionLine] = firstPromotion.kind === 'PROMOTION_SELECTED' ? firstPromotion.composition.lines : [];
  const [secondPromotionLine] = secondPromotion.kind === 'PROMOTION_SELECTED' ? secondPromotion.composition.lines : [];
  if (
    firstDecisionLine === undefined ||
    secondDecisionLine === undefined ||
    firstPreRoundLine === undefined ||
    secondPreRoundLine === undefined ||
    firstRawLine === undefined ||
    secondRawLine === undefined ||
    firstPromotion.kind !== 'PROMOTION_SELECTED' ||
    secondPromotion.kind !== 'PROMOTION_SELECTED' ||
    firstPromotionLine === undefined ||
    secondPromotionLine === undefined
  ) {
    throw new Error('Issue #781 multi-line fixture requires two complete original Pricing lines');
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
      promotionComposition: {
        composition: {
          ...firstPromotion.composition,
          decision,
          lines: [firstPromotionLine, secondPromotionLine],
        },
        kind: 'PROMOTION_SELECTED',
      },
    },
  };
};

const publicationRequest = (
  preRound: PricingFinalPreRoundReady,
  publicationProfileVersion: string = PRICING_CZK_PUBLICATION_PROFILE_VERSION,
): PricingLinePublicationRequest => ({
  candidateRef,
  decision: preRound.decision,
  preRound,
  publicationProfileVersion,
});

const readyPublication = Effect.fn('test.issue781ReadyPublication')(function* readyPublicationProgram(
  request: PricingLinePublicationRequest,
) {
  const result = yield* publishPricingLineValues(request);
  if (result.outcome !== 'LINE_VALUES_PUBLISHED') {
    throw new Error(`Issue #781 fixture expected publication success, got ${result.failure.code}`);
  }
  return result;
});

describe('issue #781 Pricing rounding boundaries acceptance', () => {
  it.effect('rounds each stable original line exactly once and totals only the published 33.34 + 66.67 values', () =>
    Effect.gen(function* roundsOnceThenSumsPublishedLines() {
      const first = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-a',
        priceAmount: '33.335',
      });
      const second = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-b',
        priceAmount: '66.665',
      });
      const preRound = mergePreRoundLines(first.preRound, second.preRound);
      const published = yield* readyPublication(publicationRequest(preRound));

      expect(published.publishedLines).toMatchObject([
        {
          occurrenceId: 'line-781-a',
          publishedLineValue: money('33.34'),
          roundingAdjustment: money('0.005'),
        },
        {
          occurrenceId: 'line-781-b',
          publishedLineValue: money('66.67'),
          roundingAdjustment: money('0.005'),
        },
      ]);

      const totalRequest: PricingCommercialTotalRequest = {
        candidateRef,
        decision: preRound.decision,
        preRound,
        publishedLines: published.publishedLines,
      };
      const total = yield* calculatePricingCommercialTotals(totalRequest);
      expect(total).toMatchObject({
        breakdown: { pricingLineRoundingAdjustmentTotal: money('0.01') },
        outcome: 'COMMERCIAL_TOTAL_READY',
        pricingNetCommercialTotal: money('100.01'),
      });
      if (total.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return;
      }
      expect(total.pricingNetCommercialTotal.amount).not.toBe('100');
      expect(total.publishedLines).toEqual(published.publishedLines);
    }),
  );

  it.effect('publishes signed positive and negative rounding adjustments from exact intermediates', () =>
    Effect.gen(function* preservesSignedAdjustments() {
      const down = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-down',
        priceAmount: '12.344',
      });
      const up = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-up',
        priceAmount: '12.345',
      });

      expect((yield* readyPublication(publicationRequest(down.preRound))).publishedLines).toMatchObject([
        { publishedLineValue: money('12.34'), roundingAdjustment: money('-0.004') },
      ]);
      expect((yield* readyPublication(publicationRequest(up.preRound))).publishedLines).toMatchObject([
        { publishedLineValue: money('12.35'), roundingAdjustment: money('0.005') },
      ]);
      expect(down.preRound.lines[0]?.nonNegativePreRoundValue).toEqual(money('12.344'));
      expect(up.preRound.lines[0]?.nonNegativePreRoundValue).toEqual(money('12.345'));
    }),
  );

  it.effect('requires the governed #779 ZERO_FLOOR before rounding any raw-negative value', () =>
    Effect.gen(function* requiresFloorBeforeRounding() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['40', '40', '40'] });
      const published = yield* readyPublication(publicationRequest(preRound));
      expect(preRound.lines[0]?.floorEvaluation).toMatchObject({
        floorAdjustment: money('20'),
        kind: 'AUTHORIZED_ZERO_FLOOR',
        rawPostCompositionValue: money('-20'),
      });
      expect(published.publishedLines).toMatchObject([
        { publishedLineValue: money('0'), roundingAdjustment: money('0') },
      ]);

      const [line] = preRound.lines;
      if (line === undefined) {
        throw new Error('Issue #781 negative fixture requires one pre-round line');
      }
      const unguarded: PricingFinalPreRoundReady = {
        ...preRound,
        lines: [
          {
            ...line,
            floorEvaluation: {
              floorAdjustment: { amount: '0' as const, currencyCode: 'CZK' },
              kind: 'NOT_REQUIRED',
              nonNegativePreRoundValue: money('0'),
              rawPostCompositionValue: money('-20'),
            },
            nonNegativePreRoundValue: money('0'),
          },
        ],
      };
      expect(yield* publishPricingLineValues(publicationRequest(unguarded))).toMatchObject({
        failure: { code: 'RAW_NEGATIVE_UNGUARDED' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
    }),
  );

  it.effect(
    'keeps the #774 sub-cent allocation sum and capacity boundary separate from ZERO_FLOOR and publication',
    () =>
      Effect.gen(function* separatesAllocationAndPublicationBoundaries() {
        const allocationFirst = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          occurrenceId: 'line-781-allocation-a',
          priceAmount: '9.7097',
        });
        const allocationSecond = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          occurrenceId: 'line-781-allocation-b',
          priceAmount: '90.2975',
        });
        const allocationDecision = mergePreRoundLines(allocationFirst.preRound, allocationSecond.preRound).decision;
        const allocation = yield* allocatePricingDiscountsAndFees({
          allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
          decision: allocationDecision,
          eligibleBasis: {
            currencyCode: 'CZK',
            eligibleAmount: '100.0072',
            recipients: [
              {
                intermediateValue: money('9.7097'),
                occurrenceId: 'line-781-allocation-a',
                recipientKind: 'MERCHANDISE',
              },
              {
                intermediateValue: money('90.2975'),
                occurrenceId: 'line-781-allocation-b',
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
            logicalFactRef: 'whole-discount:781',
            ownerModuleId: 'commerce.pricing',
            revisionRef: 'whole-discount-r781',
            sourceKind: 'PRICING_DISCOUNT',
          },
        });
        expect(allocation).toMatchObject({
          allocations: [
            { amount: money('-9.709000951931460935'), occurrenceId: 'line-781-allocation-a' },
            { amount: money('-90.290999048068539065'), occurrenceId: 'line-781-allocation-b' },
          ],
          outcome: 'ALLOCATION_APPLIED',
        });
        if (allocation.outcome !== 'ALLOCATION_APPLIED') {
          throw new Error('Issue #781 allocation fixture requires an applied capacity-preserving allocation');
        }
        const [firstReduction, secondReduction] = allocation.allocations;
        if (firstReduction === undefined || secondReduction === undefined) {
          throw new Error('Issue #781 allocation fixture requires both stable original recipients');
        }
        expect(yield* addPricingExactDecimals(firstReduction.amount.amount, secondReduction.amount.amount)).toBe(
          '-100',
        );
        expect(yield* addPricingExactDecimals('9.7097', firstReduction.amount.amount)).toBe('0.000699048068539065');
        expect(yield* addPricingExactDecimals('90.2975', secondReduction.amount.amount)).toBe('0.006500951931460935');

        const residualFirst = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          occurrenceId: 'line-781-residual-a',
          priceAmount: '0.0007',
        });
        const residualSecond = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          occurrenceId: 'line-781-residual-b',
          priceAmount: '0.0065',
        });
        const residuals = mergePreRoundLines(residualFirst.preRound, residualSecond.preRound);
        const published = yield* readyPublication(publicationRequest(residuals));

        expect(residuals.lines.map(({ floorEvaluation }) => floorEvaluation.floorAdjustment)).toEqual([
          money('0'),
          money('0'),
        ]);
        expect(published.publishedLines).toMatchObject([
          { publishedLineValue: money('0'), roundingAdjustment: money('-0.0007') },
          { publishedLineValue: money('0.01'), roundingAdjustment: money('0.0035') },
        ]);
      }),
  );

  it.effect('keeps Storefront and FX out while failing typed for an unactivated EUR publication profile', () =>
    Effect.gen(function* rejectsUnactivatedCurrencyProfile() {
      const { preRound: czk } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-czk',
      });
      const published = yield* readyPublication(publicationRequest(czk));
      expect('storefrontId' in published).toBe(false);
      expect('fxRate' in published).toBe(false);
      expect('exchangeRate' in published).toBe(false);
      expect(yield* encodeJson(published)).not.toMatch(/storefront|fxRate|exchangeRate/iu);

      const { preRound: eur } = yield* makeIssue779PreRoundScenario({
        currencyCode: 'EUR',
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-781-eur',
      });
      expect(yield* publishPricingLineValues(publicationRequest(czk, 'pricing-eur-publication-v1'))).toMatchObject({
        failure: { code: 'UNSUPPORTED_PROFILE' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
      expect(yield* publishPricingLineValues(publicationRequest(eur))).toMatchObject({
        failure: { code: 'UNSUPPORTED_CURRENCY' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
    }),
  );
});
