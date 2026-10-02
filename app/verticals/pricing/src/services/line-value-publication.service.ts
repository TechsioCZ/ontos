import {
  PricingLinePublicationReadySchema,
  PricingLinePublicationRequestSchema,
  roundPricingExactDecimalHalfUp,
} from '@app/pricing-contracts/domain/rounding-boundary';
import type {
  PricingLinePublicationFailed,
  PricingLinePublicationFailureCode,
  PricingLinePublicationRequest,
  PricingLinePublicationResult,
} from '@app/pricing-contracts/domain/rounding-boundary';
import type { PricingPublishedCommercialLine } from '@app/pricing-contracts/domain/commercial-total';
import {
  PRICING_EXACT_DECIMAL_INTEGER_DIGITS,
  PRICING_EXACT_DECIMAL_SCALE,
  resolvePricingPublicationProfile,
  subtractPricingExactDecimals,
} from '@app/pricing-contracts/domain/exact-decimal';
import { Effect, Option, Schema } from 'effect';

type LinePublicationState =
  | { readonly code: PricingLinePublicationFailureCode; readonly kind: 'FAILED' }
  | { readonly kind: 'PUBLISHED'; readonly line: PricingPublishedCommercialLine };

const failed = (
  candidateRef: string,
  code: PricingLinePublicationFailed['failure']['code'],
  message: string,
): PricingLinePublicationFailed => ({
  candidateRef,
  failure: { code, message, retryable: false },
  outcome: 'LINE_PUBLICATION_FAILED',
});

const decimalScale = (value: string): number => value.split('.')[1]?.length ?? 0;

const decimalIntegerDigits = (value: string): number => {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  return unsigned.split('.')[0]?.length ?? 1;
};

const exactAmountExceedsProfile = (amount: string): boolean =>
  decimalScale(amount) > PRICING_EXACT_DECIMAL_SCALE ||
  decimalIntegerDigits(amount) > PRICING_EXACT_DECIMAL_INTEGER_DIGITS;

const lineCurrencies = (request: PricingLinePublicationRequest): readonly string[] =>
  request.preRound.lines.flatMap(({ composition, floorEvaluation, nonNegativePreRoundValue }) => [
    composition.unitPriceCalculation.baseLineValue.currencyCode,
    composition.unitPriceCalculation.unitPrice.currencyCode,
    composition.feeCalculation.contributionTotal.currencyCode,
    composition.feeCalculation.discountableLineBasis.currencyCode,
    ...composition.feeCalculation.contributions.map(({ amount }) => amount.currencyCode),
    ...composition.lineDiscountContributions.map(({ amount }) => amount.currencyCode),
    ...(composition.wholePurchaseAllocation === undefined
      ? []
      : [composition.wholePurchaseAllocation.amount.currencyCode]),
    ...(composition.promotionAllocation === undefined ? [] : [composition.promotionAllocation.amount.currencyCode]),
    composition.prePromotionValue.currencyCode,
    composition.rawPostCompositionValue.currencyCode,
    floorEvaluation.rawPostCompositionValue.currencyCode,
    floorEvaluation.floorAdjustment.currencyCode,
    floorEvaluation.nonNegativePreRoundValue.currencyCode,
    nonNegativePreRoundValue.currencyCode,
  ]);

const preflightFailure = (request: PricingLinePublicationRequest): PricingLinePublicationFailed | undefined => {
  const { candidateRef, decision, preRound } = request;
  if (lineCurrencies(request).some((currencyCode) => currencyCode !== decision.currencyCode)) {
    return failed(candidateRef, 'CURRENCY_MISMATCH', 'Final-line publication cannot combine or relabel currencies');
  }

  if (decision.currencyCode !== 'CZK') {
    return failed(
      candidateRef,
      'UNSUPPORTED_CURRENCY',
      'No final-line publication profile is activated for the Decision currency',
    );
  }

  for (const line of preRound.lines) {
    const rawAmount = line.composition.rawPostCompositionValue.amount;
    if (
      line.nonNegativePreRoundValue.amount.startsWith('-') ||
      (rawAmount.startsWith('-') && line.floorEvaluation.kind !== 'AUTHORIZED_ZERO_FLOOR')
    ) {
      return failed(
        candidateRef,
        'RAW_NEGATIVE_UNGUARDED',
        'A raw-negative line requires its governed ZERO_FLOOR authorization before publication rounding',
      );
    }
    if (
      [
        rawAmount,
        line.floorEvaluation.floorAdjustment.amount,
        line.floorEvaluation.nonNegativePreRoundValue.amount,
        line.nonNegativePreRoundValue.amount,
      ].some(exactAmountExceedsProfile)
    ) {
      return failed(
        candidateRef,
        'UNSUPPORTED_PRECISION',
        'A post-guard line amount exceeds the exact Pricing arithmetic profile',
      );
    }
  }
  return undefined;
};

/**
 * Applies the one ordinary publication boundary after #779's governed non-negative guard.
 * Each original stable occurrence is rounded exactly once; candidate totals remain owned by #780.
 */
export const publishPricingLineValues = Effect.fn('PricingLineValuePublication.publish')(
  function* publishPricingLineValuesProgram(
    input: PricingLinePublicationRequest,
  ): Effect.fn.Return<PricingLinePublicationResult> {
    const earlyFailure = preflightFailure(input);
    if (earlyFailure !== undefined) {
      return earlyFailure;
    }

    const requestOption = Schema.decodeOption(PricingLinePublicationRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(requestOption)) {
      return failed(
        input.candidateRef,
        'EVIDENCE_UNVERIFIABLE',
        'Final-line publication requires one exact candidate, Decision, and complete post-guard evidence',
      );
    }
    const request = requestOption.value;

    const publicationProfileOption = yield* resolvePricingPublicationProfile(request.publicationProfileVersion).pipe(
      Effect.option,
    );
    if (Option.isNone(publicationProfileOption)) {
      return failed(
        request.candidateRef,
        'UNSUPPORTED_PROFILE',
        'The requested final-line publication profile is not activated',
      );
    }
    const publicationProfile = publicationProfileOption.value;
    if (publicationProfile.currencyCode !== request.decision.currencyCode) {
      return failed(
        request.candidateRef,
        'UNSUPPORTED_CURRENCY',
        'The active publication profile does not support the Decision currency',
      );
    }

    const lineResults = yield* Effect.forEach(
      request.preRound.lines,
      (line): Effect.Effect<LinePublicationState> => {
        const exactPreRoundAmount = line.nonNegativePreRoundValue.amount;
        const publishedAmount = roundPricingExactDecimalHalfUp(exactPreRoundAmount, publicationProfile.publishedScale);
        if (publishedAmount === undefined) {
          return Effect.succeed({ code: 'UNSUPPORTED_PRECISION' as const, kind: 'FAILED' as const });
        }
        return subtractPricingExactDecimals(publishedAmount, exactPreRoundAmount).pipe(
          Effect.option,
          Effect.map((roundingAdjustmentOption) =>
            Option.isSome(roundingAdjustmentOption)
              ? {
                  kind: 'PUBLISHED' as const,
                  line: {
                    occurrenceId: line.occurrenceId,
                    publicationProfile,
                    publishedLineValue: {
                      amount: publishedAmount,
                      currencyCode: request.decision.currencyCode,
                    },
                    roundingAdjustment: {
                      amount: roundingAdjustmentOption.value,
                      currencyCode: request.decision.currencyCode,
                    },
                  },
                }
              : { code: 'ARITHMETIC_OVERFLOW' as const, kind: 'FAILED' as const },
          ),
        );
      },
      { concurrency: 1 },
    );
    const lineFailure = lineResults.find((result) => result.kind === 'FAILED');
    if (lineFailure?.kind === 'FAILED') {
      return failed(
        request.candidateRef,
        lineFailure.code,
        lineFailure.code === 'UNSUPPORTED_PRECISION'
          ? 'The post-guard line value cannot be published at the declared profile precision'
          : 'The signed final-line rounding adjustment exceeded the exact Pricing arithmetic profile',
      );
    }
    const publishedLines = lineResults.flatMap((result) => (result.kind === 'PUBLISHED' ? [result.line] : []));

    const ready = {
      candidateRef: request.candidateRef,
      decision: request.decision,
      outcome: 'LINE_VALUES_PUBLISHED' as const,
      publicationProfile,
      publishedLines,
      sourceEvidence: { preRound: request.preRound },
    };
    const decoded = Schema.decodeOption(PricingLinePublicationReadySchema, {
      onExcessProperty: 'error',
    })(ready);
    return Option.isSome(decoded)
      ? decoded.value
      : failed(
          request.candidateRef,
          'EVIDENCE_UNVERIFIABLE',
          'Published lines could not retain the exact original post-guard evidence chain',
        );
  },
);
