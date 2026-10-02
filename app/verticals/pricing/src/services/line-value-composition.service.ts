import type {
  PricingAppliedCommercialFeeCalculation,
  PricingLineCompositionRequest,
  PricingRawCompositionFailed,
  PricingRawCompositionLine,
  PricingRawCompositionResult,
} from '@app/pricing-contracts/domain/line-composition';
import {
  PricingRawCompositionFailedSchema,
  PricingRawCompositionReadySchema,
} from '@app/pricing-contracts/domain/line-composition';
import type { PricingCommercialFeeCalculationResult } from '@app/pricing-contracts/domain/commercial-fee';
import type { PricingDiscountLineContribution } from '@app/pricing-contracts/domain/discount-composition';
import type { PricingAllocationLine } from '@app/pricing-contracts/domain/discount-fee-allocation';
import {
  PricingCatalogSelectionSchema,
  PricingCommercialScopeSchema,
  PricingDecisionSchema,
  PricingLineSchema,
  PricingUnitBasisSchema,
} from '@app/pricing-contracts/pricing-decision';
import type {
  PricingPromotionComposedLine,
  PricingPromotionMerchandiseAllocation,
} from '@app/pricing-contracts/domain/promotion-composition';
import type { PricingUnitPriceCalculationSuccess } from '@app/pricing-contracts/domain/unit-price-calculation';
import { Effect, Schema } from 'effect';

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

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) {
    return '0';
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const integer = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/u, '');
  const fractionalSuffix = fraction.length === 0 ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}${integer}${fractionalSuffix}`;
};

const sumDecimals = (values: readonly string[]): string => {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  return formatDecimal(
    parts.reduce((sum, part) => sum + alignedCoefficient(part, scale), 0n),
    scale,
  );
};

const decimalsEqual = (left: string, right: string): boolean => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return alignedCoefficient(leftParts, scale) === alignedCoefficient(rightParts, scale);
};

const isNegative = (value: string): boolean => decimalParts(value).coefficient < 0n;
const isNonNegative = (value: string): boolean => decimalParts(value).coefficient >= 0n;

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameUnitBasis = Schema.toEquivalence(PricingUnitBasisSchema);

const failed = (
  candidateRef: string,
  type: PricingRawCompositionFailed['failure']['type'],
  reason: string,
  retryable = false,
): PricingRawCompositionFailed => ({
  candidateRef,
  failure: { reason, retryable, type },
  outcome: 'RAW_COMPOSITION_FAILED',
});

const appliedFee = (
  result: PricingCommercialFeeCalculationResult | undefined,
): PricingAppliedCommercialFeeCalculation | undefined =>
  result?.outcome === 'COMMERCIAL_FEES_APPLIED' ? result : undefined;

const exactLineSet = <T>(
  decisionOccurrenceIds: readonly string[],
  values: readonly T[],
  occurrenceId: (value: T) => string,
): boolean => {
  const ids = values.map(occurrenceId);
  const idSet = new Set(ids);
  return (
    ids.length === decisionOccurrenceIds.length &&
    idSet.size === ids.length &&
    decisionOccurrenceIds.every((id) => idSet.has(id))
  );
};

const wholePurchaseEvidenceIsCoherent = (request: PricingLineCompositionRequest): boolean => {
  const contribution = request.discountComposition.wholePurchaseContribution;
  const allocation = request.wholePurchaseAllocation;
  if (allocation?.outcome === 'ALLOCATION_NOT_APPLICABLE') {
    return (
      contribution === undefined &&
      sameDecision(allocation.request.decision, request.decision) &&
      allocation.request.source.sourceKind === 'PRICING_DISCOUNT'
    );
  }
  if (contribution === undefined || allocation === undefined) {
    return contribution === undefined && allocation === undefined;
  }
  return (
    allocation.request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL' &&
    sameDecision(allocation.request.decision, request.decision) &&
    allocation.request.source.sourceKind === 'PRICING_DISCOUNT' &&
    allocation.request.source.logicalFactRef === contribution.candidate.definition.discountId &&
    allocation.request.source.revisionRef === contribution.candidate.definition.revision.revisionId &&
    allocation.request.originalContribution.currencyCode === contribution.amount.currencyCode &&
    decimalsEqual(allocation.request.originalContribution.amount, contribution.amount.amount)
  );
};

const allocationInducedNegative = (
  lineNativeAmount: string,
  prePromotionAmount: string,
  rawAmount: string,
  wholeAllocation: PricingAllocationLine | undefined,
  promotionAllocation: PricingPromotionMerchandiseAllocation | undefined,
): boolean =>
  (isNonNegative(lineNativeAmount) && isNegative(prePromotionAmount) && wholeAllocation !== undefined) ||
  (isNonNegative(prePromotionAmount) && isNegative(rawAmount) && promotionAllocation !== undefined);

const attachAllocationEvidence = (input: {
  readonly composed: PricingRawCompositionLine;
  readonly promotionAllocation: PricingPromotionComposedLine['promotionAllocation'];
  readonly promotionOwnerDecisionRevision: string | undefined;
  readonly wholePurchaseAllocation: PricingAllocationLine | undefined;
  readonly wholePurchaseAllocationRevisionRef: string | undefined;
}): PricingRawCompositionLine | undefined => {
  const {
    composed,
    promotionAllocation,
    promotionOwnerDecisionRevision,
    wholePurchaseAllocation,
    wholePurchaseAllocationRevisionRef,
  } = input;
  if (promotionAllocation === undefined && wholePurchaseAllocation === undefined) {
    return composed;
  }
  if (promotionAllocation === undefined) {
    if (wholePurchaseAllocation === undefined || wholePurchaseAllocationRevisionRef === undefined) {
      return undefined;
    }
    return { ...composed, wholePurchaseAllocation, wholePurchaseAllocationRevisionRef };
  }
  if (wholePurchaseAllocation === undefined) {
    return promotionOwnerDecisionRevision === undefined
      ? undefined
      : { ...composed, promotionAllocation, promotionOwnerDecisionRevision };
  }
  if (promotionOwnerDecisionRevision === undefined || wholePurchaseAllocationRevisionRef === undefined) {
    return undefined;
  }
  return {
    ...composed,
    promotionAllocation,
    promotionOwnerDecisionRevision,
    wholePurchaseAllocation,
    wholePurchaseAllocationRevisionRef,
  };
};

const rawLineInputsAreCoherent = (input: {
  readonly decisionLine: PricingLineCompositionRequest['decision']['lines'][number];
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation;
  readonly promotionLine: PricingPromotionComposedLine | undefined;
  readonly unitPriceCalculation: PricingUnitPriceCalculationSuccess;
}): boolean => {
  const { decisionLine, feeCalculation, promotionLine, unitPriceCalculation } = input;
  const promotionBindingMatches =
    promotionLine === undefined ||
    (promotionLine.occurrenceId === decisionLine.occurrenceId &&
      sameCatalogSelection(promotionLine.catalogSelection, decisionLine.catalog.selection));
  return (
    sameLine(unitPriceCalculation.input.line, decisionLine) &&
    promotionBindingMatches &&
    feeCalculation.input.occurrenceId === decisionLine.occurrenceId &&
    decimalsEqual(feeCalculation.input.baseLineValue.amount, unitPriceCalculation.baseLineValue.amount) &&
    feeCalculation.input.baseLineValue.currencyCode === unitPriceCalculation.baseLineValue.currencyCode
  );
};

const promotionAmountsAreCoherent = (
  promotionLine: PricingPromotionComposedLine | undefined,
  prePromotionAmount: string,
  rawAmount: string,
): boolean =>
  promotionLine === undefined ||
  (decimalsEqual(prePromotionAmount, promotionLine.prePromotionValue.amount) &&
    decimalsEqual(rawAmount, promotionLine.rawPreTaxValue.amount));

const buildRawLine = (input: {
  readonly decisionLine: PricingLineCompositionRequest['decision']['lines'][number];
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation;
  readonly lineDiscountContributions: readonly PricingDiscountLineContribution[];
  readonly promotionLine: PricingPromotionComposedLine | undefined;
  readonly promotionOwnerDecisionRevision: string | undefined;
  readonly unitPriceCalculation: PricingUnitPriceCalculationSuccess;
  readonly wholePurchaseAllocation: PricingAllocationLine | undefined;
  readonly wholePurchaseAllocationRevisionRef: string | undefined;
}): PricingRawCompositionLine | undefined => {
  const {
    decisionLine,
    feeCalculation,
    lineDiscountContributions,
    promotionLine,
    promotionOwnerDecisionRevision,
    unitPriceCalculation,
    wholePurchaseAllocation,
    wholePurchaseAllocationRevisionRef,
  } = input;
  if (!rawLineInputsAreCoherent({ decisionLine, feeCalculation, promotionLine, unitPriceCalculation })) {
    return undefined;
  }
  const lineNativeAmount = sumDecimals([
    feeCalculation.discountableLineBasis.amount,
    ...lineDiscountContributions.map(({ amount }) => amount.amount),
  ]);
  const prePromotionAmount = sumDecimals([
    lineNativeAmount,
    ...(wholePurchaseAllocation === undefined ? [] : [wholePurchaseAllocation.amount.amount]),
  ]);
  const promotionAllocation = promotionLine?.promotionAllocation;
  const rawAmount = sumDecimals([
    prePromotionAmount,
    ...(promotionAllocation === undefined ? [] : [promotionAllocation.amount.amount]),
  ]);
  if (
    !promotionAmountsAreCoherent(promotionLine, prePromotionAmount, rawAmount) ||
    allocationInducedNegative(
      lineNativeAmount,
      prePromotionAmount,
      rawAmount,
      wholePurchaseAllocation,
      promotionAllocation,
    )
  ) {
    return undefined;
  }
  const { currencyCode } = feeCalculation.discountableLineBasis;
  const composed: PricingRawCompositionLine = {
    feeCalculation,
    line: decisionLine,
    lineDiscountContributions,
    negativeOrigin: isNegative(rawAmount) && isNegative(lineNativeAmount) ? 'LINE_NATIVE_COMPOSITION' : 'NONE',
    occurrenceId: decisionLine.occurrenceId,
    prePromotionValue: promotionLine?.prePromotionValue ?? { amount: prePromotionAmount, currencyCode },
    rawPostCompositionValue: promotionLine?.rawPreTaxValue ?? { amount: rawAmount, currencyCode },
    unitPriceCalculation,
  };
  return attachAllocationEvidence({
    composed,
    promotionAllocation,
    promotionOwnerDecisionRevision,
    wholePurchaseAllocation,
    wholePurchaseAllocationRevisionRef,
  });
};

const requestPreflightFailure = (request: PricingLineCompositionRequest): PricingRawCompositionFailed | undefined => {
  const selectedPromotion =
    request.promotionComposition.kind === 'PROMOTION_SELECTED' ? request.promotionComposition.composition : undefined;
  if (
    !sameDecision(request.discountComposition.request.decision, request.decision) ||
    (selectedPromotion !== undefined &&
      (request.candidateRef !== selectedPromotion.candidateRef ||
        !sameDecision(selectedPromotion.decision, request.decision)))
  ) {
    return failed(
      request.candidateRef,
      'EVIDENCE_UNVERIFIABLE',
      'Discount and Promotion evidence must bind the exact candidate Pricing Decision',
    );
  }
  const occurrenceIds = request.decision.lines.map(({ occurrenceId }) => occurrenceId);
  const occurrenceIdSet = new Set(occurrenceIds);
  if (
    !exactLineSet(occurrenceIds, request.unitPrices, ({ input }) => input.line.occurrenceId) ||
    !exactLineSet(occurrenceIds, request.feeResults, (result) =>
      result.outcome === 'COMMERCIAL_FEES_APPLIED' ? result.input.occurrenceId : result.occurrenceId,
    ) ||
    (selectedPromotion !== undefined &&
      !exactLineSet(occurrenceIds, selectedPromotion.lines, ({ occurrenceId }) => occurrenceId))
  ) {
    return failed(
      request.candidateRef,
      'EVIDENCE_UNVERIFIABLE',
      'Every original Pricing Line requires exactly one Unit Price and Fee, plus one Promotion-stage result when Promotion was selected',
    );
  }
  if (
    request.discountComposition.lineContributions.some(
      ({ basis, candidate }) =>
        basis.occurrenceId !== candidate.occurrenceId || !occurrenceIdSet.has(candidate.occurrenceId),
    )
  ) {
    return failed(
      request.candidateRef,
      'EVIDENCE_UNVERIFIABLE',
      'Every line Discount must bind one occurrence from the current Pricing Decision',
    );
  }
  if (request.feeResults.some(({ outcome }) => outcome !== 'COMMERCIAL_FEES_APPLIED')) {
    return failed(
      request.candidateRef,
      'UPSTREAM_NOT_READY',
      'A typed Commercial Fee conflict or failure cannot enter raw composition',
    );
  }
  return wholePurchaseEvidenceIsCoherent(request)
    ? undefined
    : failed(
        request.candidateRef,
        'EVIDENCE_UNVERIFIABLE',
        'Whole-purchase contribution and allocation must bind the same original Discount exactly once',
      );
};

const invalidRawLineFailure = (input: {
  readonly candidateRef: string;
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation;
  readonly lineDiscountContributions: readonly PricingDiscountLineContribution[];
  readonly promotionLine: PricingPromotionComposedLine | undefined;
  readonly wholePurchaseAllocation: PricingAllocationLine | undefined;
}): PricingRawCompositionFailed => {
  const { candidateRef, feeCalculation, lineDiscountContributions, promotionLine, wholePurchaseAllocation } = input;
  const lineNativeAmount = sumDecimals([
    feeCalculation.discountableLineBasis.amount,
    ...lineDiscountContributions.map(({ amount }) => amount.amount),
  ]);
  const prePromotionAmount = sumDecimals([
    lineNativeAmount,
    ...(wholePurchaseAllocation === undefined ? [] : [wholePurchaseAllocation.amount.amount]),
  ]);
  const failureType = allocationInducedNegative(
    lineNativeAmount,
    prePromotionAmount,
    promotionLine?.rawPreTaxValue.amount ?? prePromotionAmount,
    wholePurchaseAllocation,
    promotionLine?.promotionAllocation,
  )
    ? 'ALLOCATION_INDUCED_NEGATIVE'
    : 'EVIDENCE_UNVERIFIABLE';
  return failed(
    candidateRef,
    failureType,
    failureType === 'ALLOCATION_INDUCED_NEGATIVE'
      ? 'An allocation cannot create a negative recipient for ZERO_FLOOR to repair'
      : 'Raw arithmetic or original line evidence does not reconcile exactly',
  );
};

const lineDiscountEvidenceIsCoherent = (input: {
  readonly decision: PricingLineCompositionRequest['decision'];
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation;
  readonly line: PricingLineCompositionRequest['decision']['lines'][number];
  readonly lineDiscountContributions: readonly PricingDiscountLineContribution[];
  readonly unitPriceCalculation: PricingUnitPriceCalculationSuccess;
}): boolean => {
  const { decision, feeCalculation, line, lineDiscountContributions, unitPriceCalculation } = input;
  return lineDiscountContributions.every(({ basis, candidate }) => {
    const identity = candidate.definition.identityKey;
    return (
      candidate.occurrenceId === line.occurrenceId &&
      basis.occurrenceId === line.occurrenceId &&
      basis.amount.currencyCode === decision.currencyCode &&
      basis.baseLineValue.currencyCode === decision.currencyCode &&
      basis.applicablePricingFeeTotal.currencyCode === decision.currencyCode &&
      decimalsEqual(basis.amount.amount, feeCalculation.discountableLineBasis.amount) &&
      decimalsEqual(basis.baseLineValue.amount, unitPriceCalculation.baseLineValue.amount) &&
      decimalsEqual(basis.applicablePricingFeeTotal.amount, feeCalculation.contributionTotal.amount) &&
      identity.basis.kind === 'VARIANT_LINE' &&
      sameCatalogSelection(identity.basis.catalogSelection, line.catalog.selection) &&
      sameUnitBasis(identity.basis.unitBasis, line.pricingBasis) &&
      sameCommercialScope(identity.commercialScope, decision.commercialScope) &&
      identity.currencyCode === decision.currencyCode
    );
  });
};

type SelectedPromotionComposition = Extract<
  PricingLineCompositionRequest['promotionComposition'],
  { readonly kind: 'PROMOTION_SELECTED' }
>['composition'];

interface PotentialLineResults {
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation | undefined;
  readonly promotionLine: PricingPromotionComposedLine | undefined;
  readonly selectedPromotion: SelectedPromotionComposition | undefined;
  readonly unitPriceCalculation: PricingUnitPriceCalculationSuccess | undefined;
}

const lineContextEvidenceIsCoherent = (
  request: PricingLineCompositionRequest,
  feeCalculation: PricingAppliedCommercialFeeCalculation,
  selectedPromotion: SelectedPromotionComposition | undefined,
): boolean =>
  sameDecision(feeCalculation.input.decision, request.decision) &&
  (selectedPromotion === undefined || selectedPromotion.decision.currencyCode === request.decision.currencyCode);

const promotionRevisionFor = (
  promotionLine: PricingPromotionComposedLine | undefined,
  selectedPromotion: SelectedPromotionComposition | undefined,
): string | undefined => {
  if (
    promotionLine?.promotionAllocation === undefined ||
    selectedPromotion?.promotion.outcome !== 'PROMOTION_APPLIED'
  ) {
    return undefined;
  }
  return selectedPromotion.promotion.ownerDecisionRevision;
};

const wholePurchaseRevisionFor = (
  request: PricingLineCompositionRequest,
  wholePurchaseAllocation: PricingAllocationLine | undefined,
): string | undefined =>
  wholePurchaseAllocation === undefined || request.wholePurchaseAllocation === undefined
    ? undefined
    : request.wholePurchaseAllocation.request.source.revisionRef;

const composeRequestLines = (
  request: PricingLineCompositionRequest,
): PricingRawCompositionFailed | readonly PricingRawCompositionLine[] => {
  const selectedPromotion =
    request.promotionComposition.kind === 'PROMOTION_SELECTED' ? request.promotionComposition.composition : undefined;
  const unitByOccurrence = new Map(
    request.unitPrices.map((result) => [result.input.line.occurrenceId, result] as const),
  );
  const feeByOccurrence = new Map(
    request.feeResults.map(
      (result) =>
        [
          result.outcome === 'COMMERCIAL_FEES_APPLIED' ? result.input.occurrenceId : result.occurrenceId,
          result,
        ] as const,
    ),
  );
  const promotionByOccurrence = new Map(
    (selectedPromotion?.lines ?? []).map((line) => [line.occurrenceId, line] as const),
  );
  const wholeByOccurrence = new Map(
    (request.wholePurchaseAllocation?.outcome === 'ALLOCATION_APPLIED'
      ? request.wholePurchaseAllocation.allocations
      : []
    ).map((allocation) => [allocation.occurrenceId, allocation] as const),
  );
  const lines: PricingRawCompositionLine[] = [];
  for (const decisionLine of request.decision.lines) {
    const potentialResults: PotentialLineResults = {
      feeCalculation: appliedFee(feeByOccurrence.get(decisionLine.occurrenceId)),
      promotionLine: promotionByOccurrence.get(decisionLine.occurrenceId),
      selectedPromotion,
      unitPriceCalculation: unitByOccurrence.get(decisionLine.occurrenceId),
    };
    if (
      potentialResults.unitPriceCalculation === undefined ||
      potentialResults.feeCalculation === undefined ||
      (potentialResults.selectedPromotion !== undefined && potentialResults.promotionLine === undefined)
    ) {
      return failed(
        request.candidateRef,
        'UPSTREAM_NOT_READY',
        'A required successful line result is absent from raw composition',
      );
    }
    const { feeCalculation, promotionLine, unitPriceCalculation } = potentialResults;
    if (!lineContextEvidenceIsCoherent(request, feeCalculation, selectedPromotion)) {
      return failed(
        request.candidateRef,
        'EVIDENCE_UNVERIFIABLE',
        'Line evidence must bind one exact Decision, currency, and context',
      );
    }
    const lineDiscountContributions = request.discountComposition.lineContributions.filter(
      ({ candidate }) => candidate.occurrenceId === decisionLine.occurrenceId,
    );
    if (
      !lineDiscountEvidenceIsCoherent({
        decision: request.decision,
        feeCalculation,
        line: decisionLine,
        lineDiscountContributions,
        unitPriceCalculation,
      })
    ) {
      return failed(
        request.candidateRef,
        'EVIDENCE_UNVERIFIABLE',
        'Each line Discount must bind the current #778 line, Fee basis, context, and exact Catalog Variant',
      );
    }
    const wholePurchaseAllocation = wholeByOccurrence.get(decisionLine.occurrenceId);
    const promotionOwnerDecisionRevision = promotionRevisionFor(promotionLine, selectedPromotion);
    const wholePurchaseAllocationRevisionRef = wholePurchaseRevisionFor(request, wholePurchaseAllocation);
    const rawLine = buildRawLine({
      decisionLine,
      feeCalculation,
      lineDiscountContributions,
      promotionLine,
      promotionOwnerDecisionRevision,
      unitPriceCalculation,
      wholePurchaseAllocation,
      wholePurchaseAllocationRevisionRef,
    });
    if (rawLine === undefined) {
      return invalidRawLineFailure({
        candidateRef: request.candidateRef,
        feeCalculation,
        lineDiscountContributions,
        promotionLine,
        wholePurchaseAllocation,
      });
    }
    lines.push(rawLine);
  }
  return lines;
};

/** Produces exact raw post-composition values; ZERO_FLOOR, rounding, and totals are downstream. */
export const composePricingRawLines = Effect.fn('PricingLineValueComposition.composeRaw')(
  function* composePricingRawLinesProgram(
    input: PricingLineCompositionRequest,
  ): Effect.fn.Return<PricingRawCompositionResult> {
    const request = input;
    const preflightFailure = requestPreflightFailure(request);
    if (preflightFailure !== undefined) {
      return preflightFailure;
    }
    const composedLines = composeRequestLines(request);
    if (Schema.is(PricingRawCompositionFailedSchema)(composedLines)) {
      return composedLines;
    }
    const readyBase = {
      candidateRef: request.candidateRef,
      decision: request.decision,
      lines: composedLines,
      outcome: 'RAW_COMPOSITION_READY' as const,
      promotionComposition: request.promotionComposition,
    };
    const candidate =
      request.wholePurchaseAllocation === undefined
        ? readyBase
        : { ...readyBase, wholePurchaseAllocationEvidence: request.wholePurchaseAllocation };
    return yield* Schema.decodeEffect(PricingRawCompositionReadySchema, {
      onExcessProperty: 'error',
    })(candidate).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.succeed(
          failed(
            request.candidateRef,
            'EVIDENCE_UNVERIFIABLE',
            'The exact raw composition cannot be published with incomplete or inconsistent evidence',
          ),
        ),
      ),
    );
  },
);
