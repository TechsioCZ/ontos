import { Schema } from 'effect';

import {
  CurrentSupportedCurrenciesSuccessSchema,
  PricingCurrencyCodeSchema,
} from '../apis/current-supported-currencies.ts';
import {
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  PricingCzkPublicationProfileSchema,
  PricingExactMoneySchema,
  PricingExactNonNegativeDecimalSchema,
  PricingExactNonPositiveDecimalSchema,
} from './exact-decimal.ts';
import { PricingAllocationLineSchema } from './discount-fee-allocation.ts';
import { PricingFinalPreRoundReadySchema } from './line-composition.ts';
import type { PricingFinalPreRoundReady } from './line-composition.ts';
import {
  PricingDecisionSchema,
  PricingLineSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';
import type { PricingDecision } from './pricing-decision.ts';
import { PricingPromotionMerchandiseAllocationSchema } from './promotion-composition.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const decimalSumEquals = (expected: string, values: readonly string[]): boolean => {
  const parts = [decimalParts(expected), ...values.map(decimalParts)];
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const [expectedParts, ...valueParts] = parts;
  return (
    expectedParts !== undefined &&
    alignedCoefficient(expectedParts, scale) ===
      valueParts.reduce((sum, part) => sum + alignedCoefficient(part, scale), 0n)
  );
};

const decimalScale = (value: string): number => value.split('.')[1]?.length ?? 0;
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const sameAllocationLine = Schema.toEquivalence(PricingAllocationLineSchema);
const samePromotionAllocation = Schema.toEquivalence(PricingPromotionMerchandiseAllocationSchema);
const sameCurrencySupport = Schema.toEquivalence(CurrentSupportedCurrenciesSuccessSchema);

const PricingPublishedMoneySchema = Schema.Struct({
  amount: PricingExactNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
}).check(
  Schema.makeFilter(({ amount }) =>
    decimalScale(amount) <= 2 ? undefined : 'Published money must use the Launch 0.01 precision',
  ),
);

const PricingNonNegativeTotalSchema = Schema.Struct({
  amount: PricingExactNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingNonPositiveTotalSchema = Schema.Struct({
  amount: PricingExactNonPositiveDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

export const PricingPublishedCommercialLineSchema = Schema.Struct({
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  publicationProfile: PricingCzkPublicationProfileSchema,
  publishedLineValue: PricingPublishedMoneySchema,
  roundingAdjustment: PricingExactMoneySchema,
});
export type PricingPublishedCommercialLine = typeof PricingPublishedCommercialLineSchema.Type;

export const PricingCommercialTotalBreakdownSchema = Schema.Struct({
  baseLineTotal: PricingNonNegativeTotalSchema,
  commercialFeeTotal: PricingNonNegativeTotalSchema,
  pricingLineRoundingAdjustmentTotal: PricingExactMoneySchema,
  pricingOwnedDiscountTotal: PricingNonPositiveTotalSchema,
  promotionAllocationTotal: PricingNonPositiveTotalSchema,
  zeroFloorAdjustmentTotal: PricingNonNegativeTotalSchema,
});
export type PricingCommercialTotalBreakdown = typeof PricingCommercialTotalBreakdownSchema.Type;

const totalMoneyValues = (breakdown: PricingCommercialTotalBreakdown) => [
  breakdown.baseLineTotal,
  breakdown.commercialFeeTotal,
  breakdown.pricingOwnedDiscountTotal,
  breakdown.promotionAllocationTotal,
  breakdown.zeroFloorAdjustmentTotal,
  breakdown.pricingLineRoundingAdjustmentTotal,
];

const projectionCurrenciesAgree = ({
  breakdown,
  currencyCode,
  lines,
  pricingNetCommercialTotal,
}: {
  readonly breakdown?: PricingCommercialTotalBreakdown;
  readonly currencyCode: string;
  readonly lines: readonly { readonly publishedLineValue: { readonly currencyCode: string } }[];
  readonly pricingNetCommercialTotal: { readonly amount: string; readonly currencyCode: string };
}): boolean =>
  pricingNetCommercialTotal.currencyCode === currencyCode &&
  (breakdown === undefined || totalMoneyValues(breakdown).every((money) => money.currencyCode === currencyCode)) &&
  lines.every(({ publishedLineValue }) => publishedLineValue.currencyCode === currencyCode);

const projectionAlgebraIsExact = ({
  breakdown,
  lines,
  pricingNetCommercialTotal,
}: {
  readonly breakdown?: PricingCommercialTotalBreakdown;
  readonly lines: readonly { readonly publishedLineValue: { readonly amount: string } }[];
  readonly pricingNetCommercialTotal: { readonly amount: string };
}): boolean =>
  decimalSumEquals(
    pricingNetCommercialTotal.amount,
    lines.map(({ publishedLineValue }) => publishedLineValue.amount),
  ) &&
  (breakdown === undefined ||
    decimalSumEquals(
      pricingNetCommercialTotal.amount,
      totalMoneyValues(breakdown).map(({ amount }) => amount),
    ));

const exactOriginalLineSet = (
  decision: PricingDecision,
  preRound: PricingFinalPreRoundReady,
  publishedLines: readonly PricingPublishedCommercialLine[],
): boolean =>
  decision.lines.length === preRound.lines.length &&
  preRound.lines.length === preRound.rawComposition.lines.length &&
  publishedLines.length === decision.lines.length &&
  decision.lines.every((line, index) => {
    const preRoundLine = preRound.lines[index];
    const rawLine = preRound.rawComposition.lines[index];
    const publishedLine = publishedLines[index];
    return (
      preRoundLine !== undefined &&
      rawLine !== undefined &&
      publishedLine !== undefined &&
      line.occurrenceId === preRoundLine.occurrenceId &&
      line.occurrenceId === rawLine.occurrenceId &&
      line.occurrenceId === publishedLine.occurrenceId &&
      sameLine(line, preRoundLine.composition.line) &&
      sameLine(line, rawLine.line) &&
      sameLine(line, preRoundLine.composition.unitPriceCalculation.input.line) &&
      sameLine(line, rawLine.unitPriceCalculation.input.line) &&
      preRoundLine.composition.feeCalculation.input.occurrenceId === line.occurrenceId &&
      rawLine.feeCalculation.input.occurrenceId === line.occurrenceId &&
      sameDecision(preRoundLine.composition.feeCalculation.input.decision, decision) &&
      sameDecision(rawLine.feeCalculation.input.decision, decision)
    );
  });

const oneCurrentCurrencySupportProof = (decision: PricingDecision, preRound: PricingFinalPreRoundReady): boolean => {
  const proofs = preRound.lines.flatMap(({ composition }) => [
    composition.unitPriceCalculation.input.exactPrice.currencySupport,
    composition.feeCalculation.input.currencySupport,
  ]);
  const [first, ...remaining] = proofs;
  return (
    first !== undefined &&
    first.tenantId === decision.tenantId &&
    first.effectiveAt === decision.operationTime &&
    first.supportedCurrencies.includes(decision.currencyCode) &&
    remaining.every((proof) => sameCurrencySupport(first, proof))
  );
};

const publishedLinesBindPreRound = (
  currencyCode: string,
  preRound: PricingFinalPreRoundReady,
  publishedLines: readonly PricingPublishedCommercialLine[],
): boolean =>
  publishedLines.every((publishedLine, index) => {
    const sourceLine = preRound.lines[index];
    return (
      sourceLine !== undefined &&
      sourceLine.nonNegativePreRoundValue.currencyCode === currencyCode &&
      sourceLine.floorEvaluation.nonNegativePreRoundValue.currencyCode === currencyCode &&
      publishedLine.publicationProfile.currencyCode === currencyCode &&
      publishedLine.publishedLineValue.currencyCode === currencyCode &&
      publishedLine.roundingAdjustment.currencyCode === currencyCode &&
      decimalScale(publishedLine.publishedLineValue.amount) <= publishedLine.publicationProfile.publishedScale &&
      decimalSumEquals(publishedLine.publishedLineValue.amount, [
        sourceLine.nonNegativePreRoundValue.amount,
        publishedLine.roundingAdjustment.amount,
      ])
    );
  });

const preRoundFloorEvidenceIsCoherent = (currencyCode: string, preRound: PricingFinalPreRoundReady): boolean =>
  preRound.lines.every(({ composition, floorEvaluation, nonNegativePreRoundValue, occurrenceId }) => {
    const { floorAdjustment, rawPostCompositionValue } = floorEvaluation;
    if (
      occurrenceId !== composition.occurrenceId ||
      composition.rawPostCompositionValue.currencyCode !== currencyCode ||
      rawPostCompositionValue.currencyCode !== currencyCode ||
      floorAdjustment.currencyCode !== currencyCode ||
      floorEvaluation.nonNegativePreRoundValue.currencyCode !== currencyCode ||
      nonNegativePreRoundValue.currencyCode !== currencyCode ||
      rawPostCompositionValue.amount !== composition.rawPostCompositionValue.amount ||
      nonNegativePreRoundValue.amount !== floorEvaluation.nonNegativePreRoundValue.amount ||
      !decimalSumEquals(nonNegativePreRoundValue.amount, [rawPostCompositionValue.amount, floorAdjustment.amount])
    ) {
      return false;
    }
    return floorEvaluation.kind === 'NOT_REQUIRED'
      ? nonNegativePreRoundValue.amount === rawPostCompositionValue.amount
      : nonNegativePreRoundValue.amount === '0' &&
          decimalSumEquals('0', [rawPostCompositionValue.amount, floorAdjustment.amount]);
  });

const sameMoney = (
  left: { readonly amount: string; readonly currencyCode: string },
  right: { readonly amount: string; readonly currencyCode: string },
): boolean => left.amount === right.amount && left.currencyCode === right.currencyCode;

const rawCompositionEvidenceIsCoherent = (preRound: PricingFinalPreRoundReady): boolean => {
  const { lines, promotionComposition, wholePurchaseAllocationEvidence } = preRound.rawComposition;
  const promotionLinesAgree =
    promotionComposition.kind === 'PROMOTION_NOT_SELECTED'
      ? lines.every(
          (line) =>
            line.promotionAllocation === undefined &&
            line.promotionOwnerDecisionRevision === undefined &&
            sameMoney(line.prePromotionValue, line.rawPostCompositionValue),
        )
      : (() => {
          const { composition } = promotionComposition;
          if (lines.length !== composition.lines.length) {
            return false;
          }
          const promotionByOccurrence = new Map(composition.lines.map((line) => [line.occurrenceId, line] as const));
          return lines.every((line) => {
            const promotionLine = promotionByOccurrence.get(line.occurrenceId);
            if (
              promotionLine === undefined ||
              !sameMoney(line.prePromotionValue, promotionLine.prePromotionValue) ||
              !sameMoney(line.rawPostCompositionValue, promotionLine.rawPreTaxValue)
            ) {
              return false;
            }
            return line.promotionAllocation === undefined
              ? promotionLine.promotionAllocation === undefined && line.promotionOwnerDecisionRevision === undefined
              : promotionLine.promotionAllocation !== undefined &&
                  composition.promotion.outcome === 'PROMOTION_APPLIED' &&
                  line.promotionOwnerDecisionRevision === composition.promotion.ownerDecisionRevision &&
                  samePromotionAllocation(line.promotionAllocation, promotionLine.promotionAllocation);
          });
        })();
  if (!promotionLinesAgree) {
    return false;
  }
  if (wholePurchaseAllocationEvidence === undefined) {
    return lines.every(
      ({ wholePurchaseAllocation, wholePurchaseAllocationRevisionRef }) =>
        wholePurchaseAllocation === undefined && wholePurchaseAllocationRevisionRef === undefined,
    );
  }
  if (wholePurchaseAllocationEvidence.outcome === 'ALLOCATION_NOT_APPLICABLE') {
    return (
      wholePurchaseAllocationEvidence.request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE' &&
      lines.every(
        ({ wholePurchaseAllocation, wholePurchaseAllocationRevisionRef }) =>
          wholePurchaseAllocation === undefined && wholePurchaseAllocationRevisionRef === undefined,
      )
    );
  }
  if (wholePurchaseAllocationEvidence.request.allocationKind !== 'WHOLE_PURCHASE_CONTRACTUAL') {
    return false;
  }
  const allocationByOccurrence = new Map(
    wholePurchaseAllocationEvidence.allocations.map((allocation) => [allocation.occurrenceId, allocation] as const),
  );
  const allocatedLines = lines.filter(({ wholePurchaseAllocation }) => wholePurchaseAllocation !== undefined);
  return (
    allocatedLines.length === wholePurchaseAllocationEvidence.allocations.length &&
    lines.every(({ occurrenceId, wholePurchaseAllocation, wholePurchaseAllocationRevisionRef }) => {
      const allocation = allocationByOccurrence.get(occurrenceId);
      return allocation === undefined
        ? wholePurchaseAllocation === undefined && wholePurchaseAllocationRevisionRef === undefined
        : wholePurchaseAllocation !== undefined &&
            sameAllocationLine(wholePurchaseAllocation, allocation) &&
            wholePurchaseAllocationRevisionRef === wholePurchaseAllocationEvidence.request.source.revisionRef;
    })
  );
};

export const PricingCommercialTotalRequestSchema = Schema.Struct({
  candidateRef: stableReference,
  decision: PricingDecisionSchema,
  preRound: PricingFinalPreRoundReadySchema,
  publishedLines: Schema.Array(PricingPublishedCommercialLineSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
}).check(
  Schema.makeFilter(({ candidateRef, decision, preRound, publishedLines }) => {
    if (
      candidateRef !== preRound.rawComposition.candidateRef ||
      !sameDecision(decision, preRound.decision) ||
      !sameDecision(decision, preRound.rawComposition.decision)
    ) {
      return 'Commercial-total input must bind one exact candidate and Pricing Decision';
    }
    if (!exactOriginalLineSet(decision, preRound, publishedLines)) {
      return 'Commercial-total input must preserve every original Pricing Line exactly once and in stable order';
    }
    if (!oneCurrentCurrencySupportProof(decision, preRound)) {
      return 'Commercial-total input must retain one equivalent Current Tenant Currency Support proof across every line';
    }
    if (!preRoundFloorEvidenceIsCoherent(decision.currencyCode, preRound)) {
      return 'Commercial-total input must bind every outer pre-round value to its exact raw composition and floor evaluation';
    }
    if (!rawCompositionEvidenceIsCoherent(preRound)) {
      return 'Commercial-total input must bind raw Promotion and whole-purchase allocations to their exact owner evidence';
    }
    return publishedLinesBindPreRound(decision.currencyCode, preRound, publishedLines)
      ? undefined
      : 'Published lines must use the Decision currency and equal their exact pre-round value plus one declared rounding adjustment';
  }),
);
export type PricingCommercialTotalRequest = typeof PricingCommercialTotalRequestSchema.Type;

const componentAmountsFromEvidence = (preRound: PricingFinalPreRoundReady) => ({
  base: preRound.lines.map(({ composition }) => composition.unitPriceCalculation.baseLineValue.amount),
  discount: preRound.lines.flatMap(({ composition }) => [
    ...composition.lineDiscountContributions.map(({ amount }) => amount.amount),
    ...(composition.wholePurchaseAllocation === undefined ? [] : [composition.wholePurchaseAllocation.amount.amount]),
  ]),
  fee: preRound.lines.map(({ composition }) => composition.feeCalculation.contributionTotal.amount),
  floor: preRound.lines.map(({ floorEvaluation }) => floorEvaluation.floorAdjustment.amount),
  promotion: preRound.lines.flatMap(({ composition }) =>
    composition.promotionAllocation === undefined ? [] : [composition.promotionAllocation.amount.amount],
  ),
});

const breakdownPreservesEvidence = (
  breakdown: PricingCommercialTotalBreakdown,
  preRound: PricingFinalPreRoundReady,
  publishedLines: readonly PricingPublishedCommercialLine[],
): boolean => {
  const components = componentAmountsFromEvidence(preRound);
  return (
    decimalSumEquals(breakdown.baseLineTotal.amount, components.base) &&
    decimalSumEquals(breakdown.commercialFeeTotal.amount, components.fee) &&
    decimalSumEquals(breakdown.pricingOwnedDiscountTotal.amount, components.discount) &&
    decimalSumEquals(breakdown.promotionAllocationTotal.amount, components.promotion) &&
    decimalSumEquals(breakdown.zeroFloorAdjustmentTotal.amount, components.floor) &&
    decimalSumEquals(
      breakdown.pricingLineRoundingAdjustmentTotal.amount,
      publishedLines.map(({ roundingAdjustment }) => roundingAdjustment.amount),
    )
  );
};

export interface PricingCommercialTotalReady {
  readonly breakdown: PricingCommercialTotalBreakdown;
  readonly calculationVersions: {
    readonly allocationContractVersions: readonly (typeof PRICING_ALLOCATION_PROFILE_VERSION)[];
    readonly arithmeticProfileVersions: readonly (typeof PRICING_ARITHMETIC_PROFILE_VERSION)[];
    readonly publicationProfileVersions: readonly (typeof PRICING_CZK_PUBLICATION_PROFILE_VERSION)[];
  };
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly outcome: 'COMMERCIAL_TOTAL_READY';
  readonly pricingNetCommercialTotal: { readonly amount: string; readonly currencyCode: string };
  readonly publishedLines: readonly PricingPublishedCommercialLine[];
  readonly sourceEvidence: { readonly preRound: PricingFinalPreRoundReady };
}

export const PricingCommercialTotalReadySchema: Schema.Codec<PricingCommercialTotalReady, unknown> = Schema.Struct({
  breakdown: PricingCommercialTotalBreakdownSchema,
  calculationVersions: Schema.Struct({
    allocationContractVersions: Schema.Array(Schema.Literal(PRICING_ALLOCATION_PROFILE_VERSION)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1),
    ),
    arithmeticProfileVersions: Schema.Array(Schema.Literal(PRICING_ARITHMETIC_PROFILE_VERSION)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1),
    ),
    publicationProfileVersions: Schema.Array(Schema.Literal(PRICING_CZK_PUBLICATION_PROFILE_VERSION)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1),
    ),
  }),
  candidateRef: stableReference,
  decision: Schema.toType(PricingDecisionSchema),
  outcome: Schema.Literal('COMMERCIAL_TOTAL_READY'),
  pricingNetCommercialTotal: PricingPublishedMoneySchema,
  publishedLines: Schema.Array(PricingPublishedCommercialLineSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  sourceEvidence: Schema.Struct({ preRound: Schema.toType(PricingFinalPreRoundReadySchema) }),
}).check(
  Schema.makeFilter((ready) => {
    const { breakdown, candidateRef, decision, pricingNetCommercialTotal, publishedLines } = ready;
    const { preRound } = ready.sourceEvidence;
    if (
      candidateRef !== preRound.rawComposition.candidateRef ||
      !sameDecision(decision, preRound.decision) ||
      !sameDecision(decision, preRound.rawComposition.decision) ||
      !exactOriginalLineSet(decision, preRound, publishedLines) ||
      !oneCurrentCurrencySupportProof(decision, preRound) ||
      !preRoundFloorEvidenceIsCoherent(decision.currencyCode, preRound) ||
      !rawCompositionEvidenceIsCoherent(preRound)
    ) {
      return 'Commercial total must preserve one exact candidate, Decision, and original published line set';
    }
    if (
      !publishedLinesBindPreRound(decision.currencyCode, preRound, publishedLines) ||
      !projectionCurrenciesAgree({
        breakdown,
        currencyCode: decision.currencyCode,
        lines: publishedLines,
        pricingNetCommercialTotal,
      })
    ) {
      return 'Commercial total must use one Decision currency and the supported publication precision';
    }
    if (!breakdownPreservesEvidence(breakdown, preRound, publishedLines)) {
      return 'Commercial-total breakdown must preserve every original contribution and allocation exactly once';
    }
    return projectionAlgebraIsExact({ breakdown, lines: publishedLines, pricingNetCommercialTotal })
      ? undefined
      : 'Pricing net commercial total must equal both the published-line sum and the exact component equation';
  }),
);

export const PricingCommercialTotalFailureCodeSchema = Schema.Literals([
  'INVALID_INPUT',
  'DECISION_CONFLICT',
  'PRECISION_MISMATCH',
  'CURRENCY_MISMATCH',
  'EVIDENCE_UNVERIFIABLE',
]);
export type PricingCommercialTotalFailureCode = typeof PricingCommercialTotalFailureCodeSchema.Type;

export const PricingCommercialTotalFailedSchema = Schema.Struct({
  candidateRef: stableReference,
  failure: Schema.Struct({
    code: PricingCommercialTotalFailureCodeSchema,
    message: boundedMessage,
    retryable: Schema.Boolean,
  }),
  outcome: Schema.Literal('COMMERCIAL_TOTAL_FAILED'),
});
export type PricingCommercialTotalFailed = typeof PricingCommercialTotalFailedSchema.Type;

export const PricingCommercialTotalResultSchema = Schema.Union([
  PricingCommercialTotalReadySchema,
  PricingCommercialTotalFailedSchema,
]);
export type PricingCommercialTotalResult = typeof PricingCommercialTotalResultSchema.Type;

export const PricingCommercialTotalSafeLineSchema = Schema.Struct({
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  publishedLineValue: PricingPublishedMoneySchema,
});
export type PricingCommercialTotalSafeLine = typeof PricingCommercialTotalSafeLineSchema.Type;

export const PricingCommercialTotalSafeProjectionSchema = Schema.Struct({
  candidateRef: stableReference,
  currencyCode: PricingCurrencyCodeSchema,
  lines: Schema.Array(PricingCommercialTotalSafeLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  pricingNetCommercialTotal: PricingPublishedMoneySchema,
}).check(
  Schema.makeFilter((projection) => {
    if (!projectionCurrenciesAgree(projection)) {
      return 'Safe Pricing projection must contain one exact currency';
    }
    return projectionAlgebraIsExact(projection)
      ? undefined
      : 'Safe Pricing projection must preserve the exact published-line sum';
  }),
);
export type PricingCommercialTotalSafeProjection = typeof PricingCommercialTotalSafeProjectionSchema.Type;
