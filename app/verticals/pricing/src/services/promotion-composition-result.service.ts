import type {
  PricingPromotionCompositionFailed,
  PricingPromotionCompositionReady,
} from '@app/pricing-contracts/domain/promotion-composition';
import {
  PricingPromotionCompositionFailedSchema,
  PricingPromotionCompositionReadySchema,
} from '@app/pricing-contracts/domain/promotion-composition';
import { Effect, Match, Schema } from 'effect';

import type { PricingPromotionCompositionFailure } from './promotion-contribution-composition.service.ts';
import { PricingPromotionUnverifiable } from './pricing-promotion-unverifiable.ts';
import type { PricingPromotionCurrentEvaluationResult } from './promotion-current-evaluation.service.ts';

const publicationFailure = (reason: string, cause?: unknown): PricingPromotionUnverifiable =>
  cause === undefined
    ? new PricingPromotionUnverifiable({ reason, retryable: true })
    : Object.defineProperty(new PricingPromotionUnverifiable({ reason, retryable: true }), 'cause', {
        configurable: true,
        value: cause,
      });

export const publishPricingPromotionCurrentEvaluation = Effect.fn(
  'PricingPromotionCompositionResult.publishCurrentEvaluation',
)(function* publishCurrentEvaluation(
  evaluation: PricingPromotionCurrentEvaluationResult,
): Effect.fn.Return<PricingPromotionCompositionReady, PricingPromotionUnverifiable> {
  const { composition, currentnessEvidence } = evaluation;
  const { request } = composition;
  const acceptedRequest = {
    applicationRequestRef: composition.ownerDecision.request.applicationRequestRef,
    candidateRef: composition.ownerDecision.request.candidate.candidateRef,
    exactPredicateRef: composition.ownerDecision.request.exactPredicateRef,
    subjectEvidence: composition.ownerDecision.request.subjectEvidence,
  };
  const basisByOccurrence = new Map(request.prePromotionBasis.lines.map((line) => [line.occurrenceId, line] as const));
  const lines = composition.lines.flatMap((line) => {
    const basis = basisByOccurrence.get(line.occurrenceId);
    if (basis === undefined) {
      return [];
    }
    const publishedLine = {
      catalogSelection: basis.catalogSelection,
      occurrenceId: line.occurrenceId,
      prePromotionValue: line.prePromotionValue,
      rawPreTaxValue: line.rawPreTaxValue,
      recipientKind: 'MERCHANDISE' as const,
    };
    return line.promotionAllocation === undefined
      ? [publishedLine]
      : [{ ...publishedLine, promotionAllocation: line.promotionAllocation }];
  });
  const promotion =
    composition.outcome === 'PROMOTION_COMPOSITION_APPLIED'
      ? {
          acceptedRequest,
          allocations: composition.ownerDecision.allocations.filter(
            (allocation) => allocation.recipientKind === 'MERCHANDISE',
          ),
          applicationIdentity: composition.ownerDecision.applicationIdentity,
          contribution: composition.ownerDecision.contribution,
          outcome: 'PROMOTION_APPLIED' as const,
          ownerDecisionRevision: composition.ownerDecision.ownerEvidence.ownerRevision,
          ownerEvidence: composition.ownerDecision.ownerEvidence,
          shippingAllocations: composition.shippingAllocations,
          target: composition.ownerDecision.target,
        }
      : {
          acceptedRequest,
          outcome: 'PROMOTION_NOT_APPLICABLE' as const,
          ownerDecisionRevision: composition.ownerDecision.ownerEvidence.ownerRevision,
          ownerEvidence: composition.ownerDecision.ownerEvidence,
          reason: composition.ownerDecision.reason,
        };
  const candidate = {
    candidateRef: request.candidate.candidateRef,
    completedPricingAllocationRefs: request.prePromotionBasis.completedPricingAllocationRefs,
    currentnessEvidence: {
      applicationRequestRef: request.applicationRequestRef,
      candidateRef: request.candidate.candidateRef,
      currencySupport: request.currencyCompatibility,
      exactPredicateRef: request.exactPredicateRef,
      ownerEvidence: currentnessEvidence,
      pricingCompositionRef: request.prePromotionBasis.pricingCompositionRef,
      pricingCompositionRevision: request.prePromotionBasis.pricingCompositionRevision,
      subjectEvidence: request.subjectEvidence,
    },
    decision: request.candidate.decision,
    lines,
    outcome: 'PROMOTION_COMPOSITION_READY' as const,
    promotion,
    stage: 'AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION' as const,
  };

  return yield* Schema.decodeEffect(PricingPromotionCompositionReadySchema, {
    onExcessProperty: 'error',
  })(candidate).pipe(
    Effect.mapError((cause) =>
      publicationFailure(
        'The accepted Promotion evaluation cannot be published with mixed or incomplete owner evidence',
        cause,
      ),
    ),
  );
});

export const publishPricingPromotionFailure = Effect.fn('PricingPromotionCompositionResult.publishFailure')(
  function* publishFailure(
    candidateRef: string,
    failure: PricingPromotionCompositionFailure,
  ): Effect.fn.Return<PricingPromotionCompositionFailed, PricingPromotionUnverifiable> {
    const publicFailure = Match.value(failure).pipe(
      Match.tag('PricingPromotionInputInvalid', ({ reason }) => ({
        reason,
        retryable: false as const,
        type: 'INPUT_INVALID' as const,
      })),
      Match.tag('PricingPromotionConflict', ({ reason }) => ({
        reason,
        retryable: false as const,
        type: 'OWNER_CONFLICT' as const,
      })),
      Match.tag('PricingPromotionParked', ({ reason }) => ({
        reason,
        retryable: false as const,
        type: 'ZERO_OR_NON_POSITIVE_ELIGIBLE_BASIS_PARKED' as const,
      })),
      Match.tag('PricingPromotionUnavailable', ({ reason }) => ({
        reason,
        retryable: true as const,
        type: 'OWNER_UNAVAILABLE' as const,
      })),
      Match.tag('PricingPromotionUnverifiable', ({ reason }) => ({
        reason,
        retryable: true as const,
        type: 'OWNER_UNVERIFIABLE' as const,
      })),
      Match.exhaustive,
    );
    return yield* Schema.decodeEffect(PricingPromotionCompositionFailedSchema, {
      onExcessProperty: 'error',
    })({ candidateRef, failure: publicFailure, outcome: 'PROMOTION_COMPOSITION_FAILED' }).pipe(
      Effect.mapError((cause) => publicationFailure('The typed Promotion failure cannot be published', cause)),
    );
  },
);
