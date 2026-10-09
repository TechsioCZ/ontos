import type {
  PromotionContributionAllocation,
  PromotionContributionApplied,
  PromotionContributionNotApplicable,
  PromotionContributionOutcome,
  PromotionContributionRequest,
  PromotionContributionSourcePort,
  PromotionCurrencyCompatibility,
  PromotionSubjectEvidence,
} from '@app/pricing-contracts/domain/promotion-contribution';
import {
  PromotionContributionOutcomeSchema,
  PromotionContributionRequestSchema,
} from '@app/pricing-contracts/domain/promotion-contribution';
import type { PricingAllocationResult } from '@app/pricing-contracts/domain/discount-fee-allocation';
import {
  PricingAllocationLineSchema,
  PricingAllocationResultSchema,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import type { PricingDecision } from '@app/pricing-contracts/pricing-decision';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Context, Effect, Match, Option, Schema } from 'effect';

import type { PricingDiscountFeeAllocationCompositionReady } from './discount-fee-allocation-composition.service.ts';
import { PricingPromotionConflict } from './pricing-promotion-conflict.ts';
import { PricingPromotionInputInvalid } from './pricing-promotion-input-invalid.ts';
import { PricingPromotionParked } from './pricing-promotion-parked.ts';
import { PricingPromotionUnavailable } from './pricing-promotion-unavailable.ts';
import { PricingPromotionUnverifiable } from './pricing-promotion-unverifiable.ts';

export { PricingPromotionConflict } from './pricing-promotion-conflict.ts';
export { PricingPromotionInputInvalid } from './pricing-promotion-input-invalid.ts';
export { PricingPromotionParked } from './pricing-promotion-parked.ts';
export { PricingPromotionUnavailable } from './pricing-promotion-unavailable.ts';
export { PricingPromotionUnverifiable } from './pricing-promotion-unverifiable.ts';

export type PricingPromotionCompositionFailure =
  | PricingPromotionConflict
  | PricingPromotionInputInvalid
  | PricingPromotionParked
  | PricingPromotionUnavailable
  | PricingPromotionUnverifiable;

type PricingMoney = PromotionContributionRequest['prePromotionBasis']['lines'][number]['amount'];
type PromotionShippingAllocation = Extract<PromotionContributionAllocation, { readonly recipientKind: 'SHIPPING' }>;
type PromotionMerchandiseAllocation = Extract<
  PromotionContributionAllocation,
  { readonly recipientKind: 'MERCHANDISE' }
>;

export interface PricingPromotionCompositionInput {
  readonly applicationRequestRef: string;
  readonly candidateRef: string;
  readonly currencyCompatibility: PromotionCurrencyCompatibility;
  readonly decision: PricingDecision;
  readonly exactPredicateRef: string;
  readonly pricingComposition: PricingDiscountFeeAllocationCompositionReady;
  readonly pricingCompositionRef: string;
  readonly pricingCompositionRevision: string;
  readonly subjectEvidence: PromotionSubjectEvidence;
}

export interface PricingPromotionComposedLine {
  readonly occurrenceId: string;
  readonly prePromotionValue: PricingMoney;
  readonly promotionAllocation?: PromotionMerchandiseAllocation;
  readonly rawPreTaxValue: PricingMoney;
}

interface PricingPromotionCompositionReadyBase {
  readonly lines: readonly PricingPromotionComposedLine[];
  readonly request: PromotionContributionRequest;
}

export interface PricingPromotionCompositionApplied extends PricingPromotionCompositionReadyBase {
  readonly outcome: 'PROMOTION_COMPOSITION_APPLIED';
  readonly ownerDecision: PromotionContributionApplied;
  /** Delivery-owned allocations are retained as evidence and are never applied to Pricing lines. */
  readonly shippingAllocations: readonly PromotionShippingAllocation[];
}

export interface PricingPromotionCompositionNotApplicable extends PricingPromotionCompositionReadyBase {
  readonly outcome: 'PROMOTION_COMPOSITION_NOT_APPLICABLE';
  readonly ownerDecision: PromotionContributionNotApplicable;
  readonly shippingAllocations: readonly [];
}

export type PricingPromotionCompositionResult =
  | PricingPromotionCompositionApplied
  | PricingPromotionCompositionNotApplicable;

export interface PricingPromotionCompositionService {
  readonly compose: (
    input: PricingPromotionCompositionInput,
  ) => Effect.Effect<PricingPromotionCompositionResult, PricingPromotionCompositionFailure>;
}

class PricingPromotionComposition extends Context.Service<
  PricingPromotionComposition,
  PricingPromotionCompositionService
>()('@app/pricing/services/promotion-contribution-composition.service/PricingPromotionComposition') {}

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

const addDecimals = (left: string, right: string): string => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const coefficient = alignedCoefficient(leftParts, scale) + alignedCoefficient(rightParts, scale);
  if (coefficient === 0n) {
    return '0';
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const integer = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/u, '');
  const fractionSuffix = fraction.length === 0 ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}${integer}${fractionSuffix}`;
};

const isPositive = (value: string): boolean => decimalParts(value).coefficient > 0n;
const isNonPositive = (value: string): boolean => decimalParts(value).coefficient <= 0n;

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameRequest = Schema.toEquivalence(PromotionContributionRequestSchema);
const sameAllocationLine = Schema.toEquivalence(PricingAllocationLineSchema);

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;

const sourceReference = (result: PricingAllocationResult): string => {
  const { source } = result.request;
  return `${source.ownerModuleId}:${source.logicalFactRef}:${source.revisionRef}`;
};

const exactLineSets = (
  decisionOccurrenceIds: readonly string[],
  composedOccurrenceIds: readonly string[],
  intermediateOccurrenceIds: readonly string[],
): boolean => {
  const composedSet = new Set(composedOccurrenceIds);
  const intermediateSet = new Set(intermediateOccurrenceIds);
  return (
    distinct(composedOccurrenceIds) &&
    distinct(intermediateOccurrenceIds) &&
    composedOccurrenceIds.length === decisionOccurrenceIds.length &&
    intermediateOccurrenceIds.length === decisionOccurrenceIds.length &&
    decisionOccurrenceIds.every((occurrenceId) => composedSet.has(occurrenceId) && intermediateSet.has(occurrenceId))
  );
};

const allocationEvidenceBindsDecision = (
  allocationResults: readonly PricingAllocationResult[],
  decision: PricingDecision,
): boolean =>
  allocationResults.every((result) => {
    const decodedResult = Schema.decodeOption(PricingAllocationResultSchema, { onExcessProperty: 'error' })(result);
    return (
      Option.isSome(decodedResult) &&
      decodedResult.value.outcome !== 'ALLOCATION_FAILED' &&
      sameDecision(decodedResult.value.request.decision, decision)
    );
  });

const composedAllocationsBindCompletedEvidence = (
  allocationResults: readonly PricingAllocationResult[],
  composedLines: PricingDiscountFeeAllocationCompositionReady['composedLines'],
): boolean => {
  const completedAllocations = allocationResults.flatMap((result) => {
    if (
      result.outcome !== 'ALLOCATION_APPLIED' ||
      (result.request.allocationKind === 'OWNER_EXACT' && result.request.ownerScope === 'LINE_NATIVE')
    ) {
      return [];
    }
    return result.allocations;
  });
  return composedLines.every(({ multiLineAllocations, occurrenceId }) => {
    const expected = completedAllocations.filter((allocation) => allocation.occurrenceId === occurrenceId);
    return (
      expected.length === multiLineAllocations.length &&
      expected.every((allocation, index) => {
        const composed = multiLineAllocations[index];
        return composed !== undefined && sameAllocationLine(allocation, composed);
      })
    );
  });
};

const sumAllocationAmounts = (
  allocations: PricingDiscountFeeAllocationCompositionReady['composedLines'][number]['multiLineAllocations'],
): string => {
  let sum = '0';
  for (const allocation of allocations) {
    sum = addDecimals(sum, allocation.amount.amount);
  }
  return sum;
};

const composedLineBindsIntermediate = (
  composed: PricingDiscountFeeAllocationCompositionReady['composedLines'][number],
  intermediate: PricingDiscountFeeAllocationCompositionReady['lineIntermediates'][number] | undefined,
  currencyCode: string,
): boolean =>
  intermediate !== undefined &&
  composed.preAllocationIntermediateValue.currencyCode === currencyCode &&
  composed.rawPostAllocationValue.currencyCode === currencyCode &&
  intermediate.value.currencyCode === currencyCode &&
  composed.preAllocationIntermediateValue.amount === intermediate.value.amount &&
  addDecimals(composed.preAllocationIntermediateValue.amount, sumAllocationAmounts(composed.multiLineAllocations)) ===
    composed.rawPostAllocationValue.amount &&
  composed.multiLineAllocations.every(
    (allocation) =>
      allocation.occurrenceId === composed.occurrenceId && allocation.amount.currencyCode === currencyCode,
  );

const validateComposition = (
  input: PricingPromotionCompositionInput,
): Effect.Effect<PromotionContributionRequest, PricingPromotionInputInvalid | PricingPromotionUnverifiable> => {
  const decodedDecision = Schema.decodeOption(PricingDecisionSchema, { onExcessProperty: 'error' })(input.decision);
  if (Option.isNone(decodedDecision)) {
    return Effect.fail(new PricingPromotionInputInvalid({ reason: 'The Pricing candidate is invalid' }));
  }
  const { allocationResults, composedLines, lineIntermediates } = input.pricingComposition;
  if (!sameDecision(input.pricingComposition.decision, input.decision)) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'The pre-Promotion Pricing composition does not bind the exact candidate Decision',
        retryable: true,
      }),
    );
  }
  const decisionOccurrenceIds = input.decision.lines.map(({ occurrenceId }) => occurrenceId);
  const composedOccurrenceIds = composedLines.map(({ occurrenceId }) => occurrenceId);
  const intermediateOccurrenceIds = lineIntermediates.map(({ occurrenceId }) => occurrenceId);
  if (!exactLineSets(decisionOccurrenceIds, composedOccurrenceIds, intermediateOccurrenceIds)) {
    return Effect.fail(
      new PricingPromotionInputInvalid({
        reason: 'The pre-Promotion composition must preserve every original Pricing Line exactly once',
      }),
    );
  }
  if (!allocationEvidenceBindsDecision(allocationResults, input.decision)) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'The completed Pricing allocation evidence does not bind the exact candidate',
        retryable: true,
      }),
    );
  }
  if (!composedAllocationsBindCompletedEvidence(allocationResults, composedLines)) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'The pre-Promotion values do not preserve the exact completed Pricing allocations',
        retryable: true,
      }),
    );
  }
  const intermediateByOccurrence = new Map(lineIntermediates.map((line) => [line.occurrenceId, line]));
  const { currencyCode } = input.decision;
  for (const composed of composedLines) {
    const intermediate = intermediateByOccurrence.get(composed.occurrenceId);
    if (!composedLineBindsIntermediate(composed, intermediate, currencyCode)) {
      return Effect.fail(
        new PricingPromotionUnverifiable({
          reason: 'The pre-Promotion values are not the exact output after Pricing Fees and Discounts',
          retryable: true,
        }),
      );
    }
  }
  if (
    input.subjectEvidence.subject.tenantId !== input.decision.tenantId ||
    input.subjectEvidence.revalidatedAt !== input.decision.operationTime ||
    input.currencyCompatibility.tenantId !== input.decision.tenantId ||
    input.currencyCompatibility.currencyCode !== input.decision.currencyCode ||
    input.currencyCompatibility.observedAt !== input.decision.operationTime
  ) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'The actual subject or Guest evidence is not freshly bound to the Pricing operation',
        retryable: true,
      }),
    );
  }
  const composedByOccurrence = new Map(composedLines.map((line) => [line.occurrenceId, line]));
  const completedRefs = [input.pricingCompositionRef, ...allocationResults.map(sourceReference)];
  const basisLines = input.decision.lines.flatMap((line) => {
    const composed = composedByOccurrence.get(line.occurrenceId);
    return composed === undefined
      ? []
      : [
          {
            amount: composed.rawPostAllocationValue,
            catalogSelection: line.catalog.selection,
            occurrenceId: line.occurrenceId,
          },
        ];
  });
  const request = {
    applicationRequestRef: input.applicationRequestRef,
    candidate: { candidateRef: input.candidateRef, decision: input.decision },
    currencyCompatibility: input.currencyCompatibility,
    exactPredicateRef: input.exactPredicateRef,
    prePromotionBasis: {
      completedPricingAllocationRefs: [...new Set(completedRefs)],
      currencyCode: input.decision.currencyCode,
      lines: basisLines,
      monetaryBoundary: 'PRE_TAX' as const,
      pricingCompositionRef: input.pricingCompositionRef,
      pricingCompositionRevision: input.pricingCompositionRevision,
      stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS' as const,
    },
    subjectEvidence: input.subjectEvidence,
  };
  return Schema.decodeEffect(PromotionContributionRequestSchema, { onExcessProperty: 'error' })(request).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new PricingPromotionInputInvalid({ reason: 'The Promotion contribution request is invalid' }),
        'cause',
        { configurable: true, value: cause },
      ),
    ),
  );
};

const exactOwnerEvidenceIsCurrent = (
  outcome: PromotionContributionApplied | PromotionContributionNotApplicable,
  request: PromotionContributionRequest,
): boolean =>
  outcome.ownerEvidence.currentness.evaluatedAt === request.candidate.decision.operationTime &&
  outcome.ownerEvidence.currentness.revalidatedAt === request.candidate.decision.operationTime &&
  outcome.ownerEvidence.completenessEvidence.observedAt === request.candidate.decision.operationTime &&
  (outcome.ownerEvidence.completenessEvidence.nextApplicabilityBoundary === undefined ||
    outcome.ownerEvidence.completenessEvidence.nextApplicabilityBoundary > request.candidate.decision.operationTime);

const unchangedLines = (request: PromotionContributionRequest): readonly PricingPromotionComposedLine[] =>
  request.prePromotionBasis.lines.map(({ amount, occurrenceId }) => ({
    occurrenceId,
    prePromotionValue: amount,
    rawPreTaxValue: amount,
  }));

const applyOwnerAllocations = (
  outcome: PromotionContributionApplied,
  request: PromotionContributionRequest,
): Effect.Effect<PricingPromotionCompositionApplied, PricingPromotionConflict | PricingPromotionUnverifiable> => {
  const merchandise = outcome.allocations.filter(
    (allocation): allocation is PromotionMerchandiseAllocation => allocation.recipientKind === 'MERCHANDISE',
  );
  const shipping = outcome.allocations.filter(
    (allocation): allocation is PromotionShippingAllocation => allocation.recipientKind === 'SHIPPING',
  );
  const occurrenceIds = merchandise.map(({ occurrenceId }) => occurrenceId);
  const shippingRefs = shipping.map(({ deliveryComponentRef }) => deliveryComponentRef);
  if (!distinct(occurrenceIds) || !distinct(shippingRefs)) {
    return Effect.fail(
      new PricingPromotionConflict({ reason: 'Promotion returned competing allocations for one recipient identity' }),
    );
  }
  if (outcome.allocations.some(({ amount }) => !isNonPositive(amount.amount))) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'Promotion allocations must be exact non-positive owner contributions',
        retryable: true,
      }),
    );
  }
  const allocationByOccurrence = new Map(merchandise.map((allocation) => [allocation.occurrenceId, allocation]));
  for (const allocation of merchandise) {
    const basis = request.prePromotionBasis.lines.find(({ occurrenceId }) => occurrenceId === allocation.occurrenceId);
    if (basis === undefined || !isPositive(basis.amount.amount)) {
      return Effect.fail(
        new PricingPromotionUnverifiable({
          reason: 'Non-positive eligible pre-Promotion basis requires an authoritative parked owner decision',
          retryable: true,
        }),
      );
    }
  }
  return Effect.succeed({
    lines: request.prePromotionBasis.lines.map(({ amount, occurrenceId }) => {
      const promotionAllocation = allocationByOccurrence.get(occurrenceId);
      const composedLine: PricingPromotionComposedLine = {
        occurrenceId,
        prePromotionValue: amount,
        rawPreTaxValue:
          promotionAllocation === undefined
            ? amount
            : {
                amount: addDecimals(amount.amount, promotionAllocation.amount.amount),
                currencyCode: amount.currencyCode,
              },
      };
      return promotionAllocation === undefined ? composedLine : { ...composedLine, promotionAllocation };
    }),
    outcome: 'PROMOTION_COMPOSITION_APPLIED',
    ownerDecision: outcome,
    request,
    shippingAllocations: shipping,
  });
};

const interpretOutcome = (
  outcome: PromotionContributionOutcome,
  request: PromotionContributionRequest,
): Effect.Effect<PricingPromotionCompositionResult, PricingPromotionCompositionFailure> => {
  if (!sameRequest(outcome.request, request)) {
    return Effect.fail(
      new PricingPromotionUnverifiable({
        reason: 'Promotion returned a contribution for another candidate, context, subject, or basis',
        retryable: true,
      }),
    );
  }
  return Match.value(outcome).pipe(
    Match.tag('PROMOTION_CONTRIBUTION_APPLIED', (applied) =>
      exactOwnerEvidenceIsCurrent(applied, request)
        ? applyOwnerAllocations(applied, request)
        : Effect.fail(
            new PricingPromotionUnverifiable({
              reason: 'Promotion owner evidence is not exact Current',
              retryable: true,
            }),
          ),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_NOT_APPLICABLE', (notApplicable) =>
      exactOwnerEvidenceIsCurrent(notApplicable, request)
        ? Effect.succeed({
            lines: unchangedLines(request),
            outcome: 'PROMOTION_COMPOSITION_NOT_APPLICABLE' as const,
            ownerDecision: notApplicable,
            request,
            shippingAllocations: [] as const,
          })
        : Effect.fail(
            new PricingPromotionUnverifiable({
              reason: 'Promotion absence evidence is not exact Current',
              retryable: true,
            }),
          ),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS', () =>
      Effect.fail(
        new PricingPromotionParked({
          reason: 'NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION',
        }),
      ),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_INVALID', (invalid) =>
      Effect.fail(new PricingPromotionInputInvalid({ reason: invalid.reason })),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_CONFLICT', (conflict) =>
      Effect.fail(new PricingPromotionConflict({ reason: conflict.reason })),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_UNAVAILABLE', (unavailable) =>
      Effect.fail(new PricingPromotionUnavailable({ reason: unavailable.reason, retryable: true })),
    ),
    Match.tag('PROMOTION_CONTRIBUTION_UNVERIFIABLE', (unverifiable) =>
      Effect.fail(new PricingPromotionUnverifiable({ reason: unverifiable.reason, retryable: true })),
    ),
    Match.exhaustive,
  );
};

export const makePricingPromotionCompositionService = (
  source: PromotionContributionSourcePort,
): typeof PricingPromotionComposition.Service => ({
  compose: Effect.fn('PricingPromotionComposition.compose')(function* compose(input) {
    const request = yield* validateComposition(input);
    const rawOutcome = yield* source.evaluate(request);
    const decodedOutcome = Schema.decodeOption(PromotionContributionOutcomeSchema, {
      onExcessProperty: 'error',
    })(rawOutcome);
    if (Option.isNone(decodedOutcome)) {
      return yield* new PricingPromotionUnverifiable({
        reason: 'Promotion returned a malformed or incomplete owner outcome',
        retryable: true,
      });
    }
    return yield* interpretOutcome(decodedOutcome.value, request);
  }),
});

/** Explicit parked-runtime behavior. This is an unavailable owner seam, never a fabricated Promotion decision. */
export const unavailablePromotionContributionSource: PromotionContributionSourcePort = {
  evaluate: (request) =>
    Effect.succeed({
      _tag: 'PROMOTION_CONTRIBUTION_UNAVAILABLE',
      reason: 'OWNER_UNAVAILABLE',
      request,
      retryable: true,
    }),
};
