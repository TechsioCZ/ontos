import type {
  PromotionContributionOwnerEvidence,
  PromotionContributionRequest,
} from '@app/pricing-contracts/domain/promotion-contribution';
import { PromotionContributionOwnerEvidenceSchema } from '@app/pricing-contracts/domain/promotion-contribution';
import { Context, Effect, Option, Schema } from 'effect';

import type {
  PricingPromotionCompositionFailure,
  PricingPromotionCompositionInput,
  PricingPromotionCompositionResult,
  PricingPromotionCompositionService,
} from './promotion-contribution-composition.service.ts';
import { PricingPromotionUnverifiable } from './pricing-promotion-unverifiable.ts';

export type PricingPromotionEvaluationAttempt = 1 | 2;

export interface PricingPromotionFreshAttemptSource {
  readonly loadFresh: (
    attempt: PricingPromotionEvaluationAttempt,
  ) => Effect.Effect<PricingPromotionCompositionInput, PricingPromotionCompositionFailure>;
}

export interface PricingPromotionCurrentnessCheck {
  /** Exact evidence emitted by the owner decision in this attempt; it must never be reconstructed from a revision. */
  readonly expectedOwnerEvidence: PromotionContributionOwnerEvidence;
  /** The complete #775 request preserves candidate, line, Tenant, SLE, Channel, Market, currency, and subject bindings. */
  readonly request: PromotionContributionRequest;
}

export const PricingPromotionOwnerEvidenceCurrentSchema = Schema.TaggedStruct('PROMOTION_OWNER_EVIDENCE_CURRENT', {
  ownerEvidence: PromotionContributionOwnerEvidenceSchema,
});

export const PricingPromotionOwnerEvidenceChangedSchema = Schema.TaggedStruct('PROMOTION_OWNER_EVIDENCE_CHANGED', {
  ownerEvidence: PromotionContributionOwnerEvidenceSchema,
});

export const PricingPromotionCurrentnessObservationSchema = Schema.Union([
  PricingPromotionOwnerEvidenceCurrentSchema,
  PricingPromotionOwnerEvidenceChangedSchema,
]);
export type PricingPromotionCurrentnessObservation = typeof PricingPromotionCurrentnessObservationSchema.Type;

export interface PricingPromotionCurrentnessProbe {
  readonly revalidate: (
    check: PricingPromotionCurrentnessCheck,
  ) => Effect.Effect<PricingPromotionCurrentnessObservation, PricingPromotionCompositionFailure>;
}

export interface PricingPromotionCurrentEvaluationResult {
  readonly attempts: PricingPromotionEvaluationAttempt;
  /** The accepted attempt only. Evidence and values from discarded attempts are never merged into this result. */
  readonly composition: PricingPromotionCompositionResult;
  /** Complete owner evidence returned by the final revalidation, preserved losslessly. */
  readonly currentnessEvidence: PromotionContributionOwnerEvidence;
}

export interface PricingPromotionCurrentEvaluationService {
  readonly evaluate: (
    source: PricingPromotionFreshAttemptSource,
  ) => Effect.Effect<PricingPromotionCurrentEvaluationResult, PricingPromotionCompositionFailure>;
}

export class PricingPromotionCurrentEvaluation extends Context.Service<
  PricingPromotionCurrentEvaluation,
  PricingPromotionCurrentEvaluationService
>()('@app/pricing/services/promotion-current-evaluation.service/PricingPromotionCurrentEvaluation') {}

const sameOwnerEvidence = Schema.toEquivalence(PromotionContributionOwnerEvidenceSchema);

export const makePricingPromotionCurrentEvaluationService = (
  compose: PricingPromotionCompositionService['compose'],
  currentnessProbe: PricingPromotionCurrentnessProbe,
): PricingPromotionCurrentEvaluationService => {
  const evaluateAttempt: (
    source: PricingPromotionFreshAttemptSource,
    attempt: PricingPromotionEvaluationAttempt,
  ) => Effect.Effect<Option.Option<PricingPromotionCurrentEvaluationResult>, PricingPromotionCompositionFailure> =
    Effect.fn('PricingPromotionCurrentEvaluation.evaluateAttempt')(
      function* evaluateFreshPromotionAttempt(source, attempt) {
        const input = yield* source.loadFresh(attempt);
        const composition = yield* compose(input);
        const expectedOwnerEvidence = composition.ownerDecision.ownerEvidence;
        const rawObservation = yield* currentnessProbe.revalidate({
          expectedOwnerEvidence,
          request: composition.request,
        });
        const observation = Schema.decodeOption(PricingPromotionCurrentnessObservationSchema, {
          onExcessProperty: 'error',
        })(rawObservation);
        if (Option.isNone(observation)) {
          return yield* new PricingPromotionUnverifiable({
            reason: 'Promotion owner currentness revalidation returned malformed or incomplete evidence',
            retryable: true,
          });
        }

        return Schema.is(PricingPromotionOwnerEvidenceCurrentSchema)(observation.value) &&
          sameOwnerEvidence(observation.value.ownerEvidence, expectedOwnerEvidence)
          ? Option.some({
              attempts: attempt,
              composition,
              currentnessEvidence: observation.value.ownerEvidence,
            })
          : Option.none();
      },
    );

  return {
    evaluate: Effect.fn('PricingPromotionCurrentEvaluation.evaluate')(function* evaluate(source) {
      const first = yield* evaluateAttempt(source, 1);
      if (Option.isSome(first)) {
        return first.value;
      }
      const second = yield* evaluateAttempt(source, 2);
      if (Option.isSome(second)) {
        return second.value;
      }
      return yield* new PricingPromotionUnverifiable({
        reason: 'Promotion owner evidence changed during the bounded Current evaluation',
        retryable: true,
      });
    }),
  };
};
