import {
  PricingCommercialTotalRequestSchema,
  PricingCommercialTotalReadySchema,
} from '@app/pricing-contracts/domain/commercial-total';
import type {
  PricingCommercialTotalFailed,
  PricingCommercialTotalFailureCode,
  PricingCommercialTotalRequest,
  PricingCommercialTotalResult,
} from '@app/pricing-contracts/domain/commercial-total';
import {
  addPricingExactDecimals,
  comparePricingExactDecimals,
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
} from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingExactDecimal } from '@app/pricing-contracts/domain/exact-decimal';
import { PricingRawCompositionLineSchema } from '@app/pricing-contracts/domain/line-composition';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Option, Schema } from 'effect';

const failed = (
  candidateRef: string,
  code: PricingCommercialTotalFailureCode,
  message: string,
): PricingCommercialTotalFailed => ({
  candidateRef,
  failure: { code, message, retryable: false },
  outcome: 'COMMERCIAL_TOTAL_FAILED',
});

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameRawLine = Schema.toEquivalence(PricingRawCompositionLineSchema);

const sameOccurrenceSet = (left: readonly string[], right: readonly string[]): boolean => {
  const rightSet = new Set(right);
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    rightSet.size === right.length &&
    left.every((occurrenceId) => rightSet.has(occurrenceId))
  );
};

const sumExact = (amounts: readonly PricingExactDecimal[]) =>
  Effect.reduce(
    amounts,
    (): PricingExactDecimal => '0',
    (total, amount) => addPricingExactDecimals(total, amount),
  );

const money = (amount: PricingExactDecimal, currencyCode: string) => ({ amount, currencyCode });

const lineCurrencies = (request: PricingCommercialTotalRequest): readonly string[] =>
  request.preRound.lines.flatMap(({ composition, floorEvaluation, nonNegativePreRoundValue }) => [
    composition.unitPriceCalculation.baseLineValue.currencyCode,
    composition.feeCalculation.contributionTotal.currencyCode,
    ...composition.feeCalculation.contributions.map(({ amount }) => amount.currencyCode),
    ...composition.lineDiscountContributions.map(({ amount }) => amount.currencyCode),
    ...(composition.wholePurchaseAllocation === undefined
      ? []
      : [composition.wholePurchaseAllocation.amount.currencyCode]),
    ...(composition.promotionAllocation === undefined ? [] : [composition.promotionAllocation.amount.currencyCode]),
    composition.rawPostCompositionValue.currencyCode,
    floorEvaluation.rawPostCompositionValue.currencyCode,
    floorEvaluation.floorAdjustment.currencyCode,
    floorEvaluation.nonNegativePreRoundValue.currencyCode,
    nonNegativePreRoundValue.currencyCode,
  ]);

const publicationCurrencies = (request: PricingCommercialTotalRequest): readonly string[] =>
  request.publishedLines.flatMap(({ publishedLineValue, roundingAdjustment }) => [
    publishedLineValue.currencyCode,
    roundingAdjustment.currencyCode,
  ]);

const preflightFailure = (request: PricingCommercialTotalRequest): PricingCommercialTotalFailed | undefined => {
  const { candidateRef, decision, preRound } = request;
  if (
    candidateRef !== preRound.rawComposition.candidateRef ||
    !sameDecision(decision, preRound.decision) ||
    !sameDecision(decision, preRound.rawComposition.decision)
  ) {
    return failed(candidateRef, 'DECISION_CONFLICT', 'Commercial totals require one exact candidate and Decision');
  }

  const decisionOccurrences = decision.lines.map(({ occurrenceId }) => occurrenceId);
  const preRoundOccurrences = preRound.lines.map(({ occurrenceId }) => occurrenceId);
  const publishedOccurrences = request.publishedLines.map(({ occurrenceId }) => occurrenceId);
  if (
    !sameOccurrenceSet(decisionOccurrences, preRoundOccurrences) ||
    !sameOccurrenceSet(decisionOccurrences, publishedOccurrences)
  ) {
    return failed(
      candidateRef,
      'EVIDENCE_UNVERIFIABLE',
      'Commercial totals require every original occurrence exactly once',
    );
  }

  const { currencyCode: expectedCurrency } = decision;
  if (
    [...lineCurrencies(request), ...publicationCurrencies(request)].some((currency) => currency !== expectedCurrency)
  ) {
    return failed(candidateRef, 'CURRENCY_MISMATCH', 'Commercial totals cannot combine or relabel currencies');
  }

  for (const published of request.publishedLines) {
    const sourceLine = preRound.lines.find(({ occurrenceId }) => occurrenceId === published.occurrenceId);
    if (sourceLine === undefined) {
      return failed(candidateRef, 'EVIDENCE_UNVERIFIABLE', 'Published line has no exact pre-round occurrence');
    }
    if (
      published.publicationProfile.currencyCode !== 'CZK' ||
      published.publicationProfile.currencyCode !== expectedCurrency ||
      published.publicationProfile.quantum !== '0.01' ||
      published.publicationProfile.roundingMode !== 'HALF_UP' ||
      published.publishedLineValue.amount.startsWith('-')
    ) {
      return failed(candidateRef, 'PRECISION_MISMATCH', 'Published line does not satisfy the declared CZK boundary');
    }
    const rawLine = preRound.rawComposition.lines.find(({ occurrenceId }) => occurrenceId === sourceLine.occurrenceId);
    if (rawLine === undefined || !sameRawLine(sourceLine.composition, rawLine)) {
      return failed(candidateRef, 'EVIDENCE_UNVERIFIABLE', 'Pre-round line does not retain its exact raw composition');
    }
  }
  return undefined;
};

/** Aggregates only already-published Pricing lines. It never rounds, floors, converts currency, or adds downstream totals. */
export const calculatePricingCommercialTotals = Effect.fn('PricingCommercialTotals.calculate')(
  function* calculatePricingCommercialTotalsProgram(
    input: PricingCommercialTotalRequest,
  ): Effect.fn.Return<PricingCommercialTotalResult> {
    const earlyFailure = preflightFailure(input);
    if (earlyFailure !== undefined) {
      return earlyFailure;
    }

    const requestOption = Schema.decodeOption(PricingCommercialTotalRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(requestOption)) {
      return failed(
        input.candidateRef,
        'INVALID_INPUT',
        'Commercial totals require a complete canonical pre-round result and publication evidence',
      );
    }
    const request = requestOption.value;
    const { currencyCode } = request.decision;

    const lineDiscounts = request.preRound.lines.flatMap(({ composition }) =>
      composition.lineDiscountContributions.map(({ amount }) => amount.amount),
    );
    const wholePurchaseAllocations = request.preRound.lines.flatMap(({ composition }) =>
      composition.wholePurchaseAllocation === undefined ? [] : [composition.wholePurchaseAllocation.amount.amount],
    );
    const sumsOption = yield* Effect.all(
      {
        baseLineTotal: sumExact(
          request.preRound.lines.map(({ composition }) => composition.unitPriceCalculation.baseLineValue.amount),
        ),
        commercialFeeTotal: sumExact(
          request.preRound.lines.map(({ composition }) => composition.feeCalculation.contributionTotal.amount),
        ),
        pricingLineRoundingAdjustmentTotal: sumExact(
          request.publishedLines.map(({ roundingAdjustment }) => roundingAdjustment.amount),
        ),
        pricingNetCommercialTotal: sumExact(
          request.publishedLines.map(({ publishedLineValue }) => publishedLineValue.amount),
        ),
        pricingOwnedDiscountTotal: sumExact([...lineDiscounts, ...wholePurchaseAllocations]),
        promotionAllocationTotal: sumExact(
          request.preRound.lines.flatMap(({ composition }) =>
            composition.promotionAllocation === undefined ? [] : [composition.promotionAllocation.amount.amount],
          ),
        ),
        zeroFloorAdjustmentTotal: sumExact(
          request.preRound.lines.map(({ floorEvaluation }) => floorEvaluation.floorAdjustment.amount),
        ),
      },
      { concurrency: 7 },
    ).pipe(Effect.option);
    if (Option.isNone(sumsOption)) {
      return failed(
        request.candidateRef,
        'PRECISION_MISMATCH',
        'Commercial total arithmetic exceeded the exact Pricing precision profile',
      );
    }
    const {
      baseLineTotal,
      commercialFeeTotal,
      pricingLineRoundingAdjustmentTotal,
      pricingNetCommercialTotal,
      pricingOwnedDiscountTotal,
      promotionAllocationTotal,
      zeroFloorAdjustmentTotal,
    } = sumsOption.value;

    const reconciledTotalOption = yield* sumExact([
      baseLineTotal,
      commercialFeeTotal,
      pricingOwnedDiscountTotal,
      promotionAllocationTotal,
      zeroFloorAdjustmentTotal,
      pricingLineRoundingAdjustmentTotal,
    ]).pipe(Effect.option);
    if (Option.isNone(reconciledTotalOption)) {
      return failed(
        request.candidateRef,
        'PRECISION_MISMATCH',
        'Commercial total reconciliation exceeded the exact Pricing precision profile',
      );
    }
    const reconciledTotal = reconciledTotalOption.value;
    if (comparePricingExactDecimals(reconciledTotal, pricingNetCommercialTotal) !== 0) {
      return failed(
        request.candidateRef,
        'EVIDENCE_UNVERIFIABLE',
        'Published Pricing lines do not reconcile with the exact commercial component breakdown',
      );
    }

    const ready = {
      breakdown: {
        baseLineTotal: money(baseLineTotal, currencyCode),
        commercialFeeTotal: money(commercialFeeTotal, currencyCode),
        pricingLineRoundingAdjustmentTotal: money(pricingLineRoundingAdjustmentTotal, currencyCode),
        pricingOwnedDiscountTotal: money(pricingOwnedDiscountTotal, currencyCode),
        promotionAllocationTotal: money(promotionAllocationTotal, currencyCode),
        zeroFloorAdjustmentTotal: money(zeroFloorAdjustmentTotal, currencyCode),
      },
      calculationVersions: {
        allocationContractVersions: [PRICING_ALLOCATION_PROFILE_VERSION],
        arithmeticProfileVersions: [PRICING_ARITHMETIC_PROFILE_VERSION],
        publicationProfileVersions: [PRICING_CZK_PUBLICATION_PROFILE_VERSION],
      },
      candidateRef: request.candidateRef,
      decision: request.decision,
      outcome: 'COMMERCIAL_TOTAL_READY' as const,
      pricingNetCommercialTotal: money(pricingNetCommercialTotal, currencyCode),
      publishedLines: request.publishedLines,
      sourceEvidence: { preRound: request.preRound },
    };
    const decoded = Schema.decodeOption(PricingCommercialTotalReadySchema, {
      onExcessProperty: 'error',
    })(ready);
    return Option.isSome(decoded)
      ? decoded.value
      : failed(
          request.candidateRef,
          'EVIDENCE_UNVERIFIABLE',
          'Canonical commercial totals could not retain a complete exact evidence chain',
        );
  },
);
