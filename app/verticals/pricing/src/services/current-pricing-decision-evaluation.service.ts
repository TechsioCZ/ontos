import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import type {
  PricingCommercialTotalReady,
  PricingCommercialTotalSafeProjection,
} from '@app/pricing-contracts/domain/commercial-total';
import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import { PricingMaterialEvidenceAssemblyRequestSchema } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingEvaluationAttempt } from '@app/pricing-contracts/domain/material-change';
import {
  PricingKnownInvalidOrConflictOutcomeSchema,
  PricingRetryExhaustedOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import { PricingDecisionOutcomeSchema, PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import type {
  PricingDecision,
  PricingDecisionOutcome,
  PricingNoApplicablePrice,
} from '@app/pricing-contracts/pricing-decision';
import { Context, Effect, Layer, Match, Schema } from 'effect';

import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
  makePricingMaterialEvidenceOwnerFinalFenceFromGateways,
} from '../integrations/material-evidence-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from '../integrations/material-evidence-owner-final-fence.ts';

import { PricingExternalOwnerEvidenceValidation } from './external-owner-evidence-validation.service.ts';
import type { PricingExternalOwnerEvidenceValidationService } from './external-owner-evidence-validation.service.ts';
import { PricingMaterialEvidenceOwnerFinalFence } from './material-evidence-final-validation.service.ts';
import type { PricingMaterialEvidenceOwnerFencePort } from './material-evidence-final-validation.service.ts';
import type {
  PricingOrdinaryCurrentEvaluationAttempt,
  PricingOrdinaryCurrentTerminalFailure,
  PricingOrdinaryCurrentWholeAttempt,
  PricingOrdinaryCurrentWholeEvaluationPort,
} from './ordinary-current-pricing-evaluation.service.ts';
import { makePricingBoundedWholeAttemptEvaluationService } from './ordinary-current-pricing-evaluation.service.ts';
import type { PricingOrdinaryCurrentPublicationRequest } from './ordinary-current-pricing-publication.service.ts';
import {
  PricingOrdinaryCurrentPublicationIndeterminate,
  publishOrdinaryCurrentPricingForCustomer,
} from './ordinary-current-pricing-publication.service.ts';
import type { CurrentPricingDecisionSubjectAuthorityEvidence } from './current-pricing-decision-subject-authority.service.ts';

export type CurrentPricingDecisionRequiredOwnerRefs = readonly [string, ...string[]];

export type CurrentPricingDecisionReadyPublication =
  | {
      readonly commercialTotal: PricingCommercialTotalReady;
      readonly kind: 'PRICE_RESOLVED';
      readonly materialEvidence: PricingMaterialEvidenceReady;
      readonly ordinaryPublicationRequest: PricingOrdinaryCurrentPublicationRequest;
    }
  | {
      readonly kind: 'NO_APPLICABLE_PRICE';
      readonly outcome: PricingNoApplicablePrice;
    };

export type CurrentPricingDecisionWholeOutcome =
  | Exclude<PricingDecisionOutcome, { readonly outcome: 'PRICE_RESOLVED' }>
  | { readonly decision: PricingDecision; readonly outcome: 'PRICE_RESOLVED' };

/**
 * The request-bound owner source retains the exact canonical outcome next to the ordinary #787
 * attempt. The ordinary attempt controls retry/coherence; the outcome preserves evidence that the
 * retry vocabulary deliberately does not project.
 */
export interface CurrentPricingDecisionWholeAttempt {
  readonly attempt: PricingOrdinaryCurrentWholeAttempt<CurrentPricingDecisionReadyPublication>;
  readonly outcome: CurrentPricingDecisionWholeOutcome;
  readonly requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs;
}

export interface CurrentPricingDecisionTrustedScope {
  readonly purchaseContextEvidence: CurrentPricingDecisionSubjectAuthorityEvidence;
  readonly sellingLegalEntityId: string;
  readonly tenantId: string;
}

export interface CurrentPricingDecisionWholeEvaluationPort {
  readonly loadFresh: (
    request: CurrentPricingDecisionRequest,
    trustedScope: CurrentPricingDecisionTrustedScope,
    attempt: PricingOrdinaryCurrentEvaluationAttempt,
  ) => Effect.Effect<CurrentPricingDecisionWholeAttempt>;
}

class CurrentPricingDecisionWholeEvaluation extends Context.Service<
  CurrentPricingDecisionWholeEvaluation,
  CurrentPricingDecisionWholeEvaluationPort
>()('@app/pricing/services/current-pricing-decision-evaluation.service/CurrentPricingDecisionWholeEvaluation') {}

export class CurrentPricingDecisionScopeViolation extends Schema.TaggedError<CurrentPricingDecisionScopeViolation>()(
  'CurrentPricingDecisionScopeViolation',
  {
    reason: Schema.Literal('TRUSTED_SCOPE_MISMATCH'),
  },
) {}

export interface CurrentPricingDecisionEvaluationService {
  readonly evaluate: (
    request: CurrentPricingDecisionRequest,
    trustedScope: CurrentPricingDecisionTrustedScope,
  ) => Effect.Effect<CurrentPricingDecisionEvaluationResult, CurrentPricingDecisionScopeViolation>;
}

export interface CurrentPricingDecisionResolvedEvaluation {
  readonly commercialTotal: PricingCommercialTotalReady;
  readonly kind: 'PRICE_RESOLVED';
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly projection: PricingCommercialTotalSafeProjection;
}

export interface CurrentPricingDecisionNonResolvedEvaluation {
  readonly kind: 'NON_RESOLVED';
  readonly outcome: Exclude<PricingDecisionOutcome, { readonly outcome: 'PRICE_RESOLVED' }>;
}

export type CurrentPricingDecisionEvaluationResult =
  | CurrentPricingDecisionResolvedEvaluation
  | CurrentPricingDecisionNonResolvedEvaluation;

export class CurrentPricingDecisionEvaluation extends Context.Service<
  CurrentPricingDecisionEvaluation,
  CurrentPricingDecisionEvaluationService
>()('@app/pricing/services/current-pricing-decision-evaluation.service/CurrentPricingDecisionEvaluation') {}

/** Transaction-scoped reads inject their whole-owner source without importing service constructors. */
export interface CurrentPricingDecisionEvaluationFactoryService {
  readonly make: (
    source: CurrentPricingDecisionWholeEvaluationPort,
    scopedPricingGateway: PricingOwnerMaterialEvidenceFenceGateway | undefined,
    compositionRevision: string,
  ) => CurrentPricingDecisionEvaluationService;
}

export class CurrentPricingDecisionEvaluationFactory extends Context.Service<
  CurrentPricingDecisionEvaluationFactory,
  CurrentPricingDecisionEvaluationFactoryService
>()('@app/pricing/services/current-pricing-decision-evaluation.service/CurrentPricingDecisionEvaluationFactory') {}

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameOutcome = Schema.toEquivalence(PricingDecisionOutcomeSchema);
const sameCommercialTotal = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameMaterialEvidenceRequest = Schema.toEquivalence(PricingMaterialEvidenceAssemblyRequestSchema);

const occurrenceIds = (request: CurrentPricingDecisionRequest): readonly string[] =>
  request.decision.lines.map((line: CurrentPricingDecisionRequest['decision']['lines'][number]) => line.occurrenceId);

type FailedDecisionOutcome = Extract<PricingDecisionOutcome, { readonly candidate: { readonly candidateRef: string } }>;

const candidateIdentityMatches = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  outcome: FailedDecisionOutcome,
): boolean =>
  outcome.candidate.candidateRef === attempt.candidateRef &&
  outcome.candidate.occurrenceIds.length === request.decision.lines.length &&
  outcome.candidate.occurrenceIds.every(
    (occurrenceId, index) => occurrenceId === request.decision.lines[index]?.occurrenceId,
  );

const outcomeBindsRequest = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  outcome: CurrentPricingDecisionWholeOutcome,
): boolean => {
  if (outcome.outcome === 'PRICE_RESOLVED' || outcome.outcome === 'NO_APPLICABLE_PRICE') {
    return sameDecision(outcome.decision, request.decision);
  }
  return candidateIdentityMatches(request, attempt, outcome);
};

const attemptKindMatchesOutcome = (whole: CurrentPricingDecisionWholeAttempt): boolean => {
  const { attempt, outcome } = whole;
  return Match.value(attempt).pipe(
    Match.when({ kind: 'READY_FOR_FINAL_PUBLICATION' }, (ready) => {
      const publication = ready.publicationRequest;
      return publication.kind === 'PRICE_RESOLVED'
        ? outcome.outcome === 'PRICE_RESOLVED' &&
            publication.commercialTotal.candidateRef === ready.attempt.candidateRef &&
            sameDecision(publication.commercialTotal.decision, outcome.decision) &&
            sameCommercialTotal(
              publication.ordinaryPublicationRequest.materialEvidence.commercialTotal,
              publication.commercialTotal,
            ) &&
            sameMaterialEvidenceRequest(
              publication.materialEvidence.sourceEvidence,
              publication.ordinaryPublicationRequest.materialEvidence,
            )
        : outcome.outcome === 'NO_APPLICABLE_PRICE' && sameOutcome(publication.outcome, outcome);
    }),
    Match.when(
      { kind: 'KNOWN_INVALID_OR_CONFLICT' },
      () => outcome.outcome === 'PRICING_CONFIGURATION_ERROR' || outcome.outcome === 'PRICING_CONFLICT',
    ),
    Match.when({ kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED' }, () => outcome.outcome === 'PRICING_STALE'),
    Match.when({ kind: 'INDETERMINATE_OR_UNVERIFIABLE' }, () => outcome.outcome === 'PRICING_INDETERMINATE'),
    Match.exhaustive,
  );
};

const retainedOwnerRefs = (whole: CurrentPricingDecisionWholeAttempt): CurrentPricingDecisionRequiredOwnerRefs =>
  whole.requiredOwnerRefs;

const indeterminateOutcome = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  attempts: number,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  reasonCode: Extract<
    PricingDecisionOutcome,
    { readonly outcome: 'PRICING_INDETERMINATE' }
  >['reasonCode'] = 'RETRY_EXHAUSTED',
): Extract<PricingDecisionOutcome, { readonly outcome: 'PRICING_INDETERMINATE' }> => ({
  candidate: { candidateRef: attempt.candidateRef, occurrenceIds: occurrenceIds(request) },
  inabilityEvidence: { attempts, requiredOwnerRefs },
  outcome: 'PRICING_INDETERMINATE',
  reasonCode,
  retryable: true,
});

const unsupportedCurrencyOutcome = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
): PricingDecisionOutcome => ({
  candidate: { candidateRef: attempt.candidateRef, occurrenceIds: occurrenceIds(request) },
  outcome: 'PRICING_CONFIGURATION_ERROR',
  reasonCode: 'UNSUPPORTED_CURRENCY',
  retryable: false,
});

const safeProjectionMatchesResolvedOutcome = (
  projection: PricingCommercialTotalSafeProjection,
  commercialTotal: PricingCommercialTotalReady,
): boolean =>
  projection.candidateRef === commercialTotal.candidateRef &&
  projection.currencyCode === commercialTotal.decision.currencyCode &&
  projection.pricingNetCommercialTotal.amount === commercialTotal.pricingNetCommercialTotal.amount &&
  projection.pricingNetCommercialTotal.currencyCode === commercialTotal.pricingNetCommercialTotal.currencyCode &&
  projection.lines.length === commercialTotal.publishedLines.length &&
  projection.lines.every((line, index) => {
    const published = commercialTotal.publishedLines[index];
    return (
      published !== undefined &&
      line.occurrenceId === published.occurrenceId &&
      line.publishedLineValue.amount === published.publishedLineValue.amount &&
      line.publishedLineValue.currencyCode === published.publishedLineValue.currencyCode
    );
  });

const publicationIndeterminate = (
  candidateRef: string,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  safeDetail: string,
): PricingOrdinaryCurrentPublicationIndeterminate =>
  new PricingOrdinaryCurrentPublicationIndeterminate({
    candidateRef,
    reasonCode: 'PUBLICATION_PROJECTION_UNVERIFIABLE',
    requiredOwnerRefs,
    retryable: true,
    safeDetail,
  });

type PublishResolvedDecision = (
  request: PricingOrdinaryCurrentPublicationRequest,
) => Effect.Effect<PricingCommercialTotalSafeProjection, PricingOrdinaryCurrentPublicationIndeterminate>;

const nonResolvedEvaluation = (
  outcome: Exclude<PricingDecisionOutcome, { readonly outcome: 'PRICE_RESOLVED' }>,
): CurrentPricingDecisionNonResolvedEvaluation => ({ kind: 'NON_RESOLVED', outcome });

const publishReadyDecision = (
  request: CurrentPricingDecisionReadyPublication,
  candidateRef: string,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  publishResolved: PublishResolvedDecision,
) => {
  if (request.kind === 'NO_APPLICABLE_PRICE') {
    return Effect.succeed<CurrentPricingDecisionEvaluationResult>(nonResolvedEvaluation(request.outcome));
  }
  return publishResolved(request.ordinaryPublicationRequest).pipe(
    Effect.flatMap((projection) =>
      safeProjectionMatchesResolvedOutcome(projection, request.commercialTotal)
        ? Effect.succeed<CurrentPricingDecisionEvaluationResult>({
            commercialTotal: request.commercialTotal,
            kind: 'PRICE_RESOLVED',
            materialEvidence: request.materialEvidence,
            projection,
          })
        : Effect.fail(
            publicationIndeterminate(
              candidateRef,
              requiredOwnerRefs,
              'Resolved Pricing outcome differs from its authorized customer projection',
            ),
          ),
    ),
  );
};

export const makeCurrentPricingDecisionEvaluationService = (
  source: CurrentPricingDecisionWholeEvaluationPort,
  publishResolved: PublishResolvedDecision,
): CurrentPricingDecisionEvaluationService => {
  const wholeEvaluation = CurrentPricingDecisionWholeEvaluation.of(source);
  return CurrentPricingDecisionEvaluation.of({
    evaluate: Effect.fn('CurrentPricingDecisionEvaluation.evaluate')(function* evaluateCurrentPricingDecision(
      request: CurrentPricingDecisionRequest,
      trustedScope: CurrentPricingDecisionTrustedScope,
    ) {
      if (
        request.decision.tenantId !== trustedScope.tenantId ||
        request.decision.commercialScope.sellingLegalEntityId !== trustedScope.sellingLegalEntityId
      ) {
        return yield* new CurrentPricingDecisionScopeViolation({ reason: 'TRUSTED_SCOPE_MISMATCH' });
      }

      const retained = new Map<string, CurrentPricingDecisionWholeAttempt>();
      const ordinarySource: PricingOrdinaryCurrentWholeEvaluationPort<CurrentPricingDecisionReadyPublication> = {
        loadFresh: (ordinal) =>
          wholeEvaluation.loadFresh(request, trustedScope, ordinal).pipe(
            Effect.map((whole) => {
              const bound =
                (whole.outcome.outcome === 'PRICE_RESOLVED' ||
                  Schema.is(PricingDecisionOutcomeSchema)(whole.outcome)) &&
                sameDecision(whole.attempt.attempt.snapshot.decision, request.decision) &&
                outcomeBindsRequest(request, whole.attempt.attempt, whole.outcome) &&
                attemptKindMatchesOutcome(whole);
              const normalized =
                request.decision.currencyCode === 'CZK'
                  ? whole
                  : {
                      ...whole,
                      attempt: {
                        attempt: whole.attempt.attempt,
                        kind: 'KNOWN_INVALID_OR_CONFLICT' as const,
                        reason: 'Launch Pricing supports CZK only',
                      },
                      outcome: unsupportedCurrencyOutcome(request, whole.attempt.attempt),
                    };
              const validated =
                bound || request.decision.currencyCode !== 'CZK'
                  ? normalized
                  : {
                      ...normalized,
                      attempt: {
                        attempt: whole.attempt.attempt,
                        kind: 'INDETERMINATE_OR_UNVERIFIABLE' as const,
                        reason: 'Whole Pricing attempt does not bind the exact request and canonical outcome',
                      },
                      outcome: indeterminateOutcome(
                        request,
                        whole.attempt.attempt,
                        ordinal,
                        retainedOwnerRefs(whole),
                        'CURRENTNESS_UNVERIFIABLE',
                      ),
                    };
              retained.set(validated.attempt.attempt.attemptId, validated);
              return validated.attempt;
            }),
          ),
      };

      const evaluation = makePricingBoundedWholeAttemptEvaluationService<
        CurrentPricingDecisionReadyPublication,
        CurrentPricingDecisionEvaluationResult
      >(ordinarySource, {
        publish: (publicationRequest) => {
          const accepted = [...retained.values()].find(({ attempt }) => {
            if (attempt.kind !== 'READY_FOR_FINAL_PUBLICATION') {
              return false;
            }
            const retainedPublication = attempt.publicationRequest;
            if (retainedPublication.kind === 'PRICE_RESOLVED' && publicationRequest.kind === 'PRICE_RESOLVED') {
              return sameCommercialTotal(retainedPublication.commercialTotal, publicationRequest.commercialTotal);
            }
            if (
              retainedPublication.kind === 'NO_APPLICABLE_PRICE' &&
              publicationRequest.kind === 'NO_APPLICABLE_PRICE'
            ) {
              return sameOutcome(retainedPublication.outcome, publicationRequest.outcome);
            }
            return false;
          });
          return accepted === undefined
            ? Effect.die('Ready Pricing publication is not bound to a retained whole attempt')
            : publishReadyDecision(
                publicationRequest,
                accepted.attempt.attempt.candidateRef,
                retainedOwnerRefs(accepted),
                publishResolved,
              );
        },
        requestBindsAttempt: (attempt, publicationRequest) => {
          const whole = retained.get(attempt.attemptId);
          if (whole === undefined) {
            return false;
          }
          return publicationRequest.kind === 'PRICE_RESOLVED'
            ? whole.outcome.outcome === 'PRICE_RESOLVED' &&
                publicationRequest.commercialTotal.candidateRef === attempt.candidateRef &&
                sameDecision(publicationRequest.commercialTotal.decision, whole.outcome.decision)
            : whole.outcome.outcome === 'NO_APPLICABLE_PRICE' && sameOutcome(publicationRequest.outcome, whole.outcome);
        },
      });

      return yield* evaluation.evaluate.pipe(
        Effect.match({
          onFailure: (failure: PricingOrdinaryCurrentTerminalFailure) => {
            let finalAttempt: PricingEvaluationAttempt | undefined;
            if (Schema.is(PricingRetryExhaustedOutcomeSchema)(failure)) {
              const { finalAttempt: retryFinalAttempt } = failure;
              finalAttempt = retryFinalAttempt;
            } else if (Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(failure)) {
              finalAttempt = failure.attempt;
            }
            if (finalAttempt !== undefined) {
              const whole = retained.get(finalAttempt.attemptId);
              if (
                whole !== undefined &&
                Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(failure) &&
                (whole.outcome.outcome === 'PRICING_CONFIGURATION_ERROR' ||
                  whole.outcome.outcome === 'PRICING_CONFLICT')
              ) {
                return Effect.succeed<CurrentPricingDecisionEvaluationResult>(nonResolvedEvaluation(whole.outcome));
              }
              if (whole !== undefined && whole.outcome.outcome === 'PRICING_STALE') {
                return Effect.succeed<CurrentPricingDecisionEvaluationResult>(nonResolvedEvaluation(whole.outcome));
              }
              if (whole !== undefined && whole.outcome.outcome === 'PRICING_INDETERMINATE') {
                return Effect.succeed<CurrentPricingDecisionEvaluationResult>(
                  nonResolvedEvaluation({
                    ...whole.outcome,
                    inabilityEvidence: { ...whole.outcome.inabilityEvidence, attempts: 2 },
                  }),
                );
              }
            }
            const mostRecent = [...retained.values()].at(-1);
            return mostRecent === undefined
              ? Effect.die('Bounded Pricing evaluation failed without retaining an attempt')
              : Effect.succeed<CurrentPricingDecisionEvaluationResult>(
                  nonResolvedEvaluation(
                    indeterminateOutcome(
                      request,
                      mostRecent.attempt.attempt,
                      retained.size,
                      retainedOwnerRefs(mostRecent),
                    ),
                  ),
                );
          },
          onSuccess: ({ publication }) => Effect.succeed<CurrentPricingDecisionEvaluationResult>(publication),
        }),
        Effect.flatMap((result) => result),
      );
    }),
  });
};

export const makeCurrentPricingDecisionEvaluationFactory = (
  publishResolved: PublishResolvedDecision,
  publishWithScopedPricingGateway?: (
    gateway: PricingOwnerMaterialEvidenceFenceGateway,
    compositionRevision: string,
  ) => PublishResolvedDecision,
): CurrentPricingDecisionEvaluationFactoryService => ({
  make: (source, scopedPricingGateway, compositionRevision) =>
    makeCurrentPricingDecisionEvaluationService(
      source,
      scopedPricingGateway === undefined || publishWithScopedPricingGateway === undefined
        ? publishResolved
        : publishWithScopedPricingGateway(scopedPricingGateway, compositionRevision),
    ),
});

const publishResolvedWithOwners = (
  externalOwnerValidation: PricingExternalOwnerEvidenceValidationService,
  ownerFinalFence: PricingMaterialEvidenceOwnerFencePort,
): PublishResolvedDecision => {
  const publishResolved: PublishResolvedDecision = (request) =>
    publishOrdinaryCurrentPricingForCustomer(request).pipe(
      Effect.provideService(PricingExternalOwnerEvidenceValidation, externalOwnerValidation),
      Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, ownerFinalFence),
    );
  return publishResolved;
};

export const currentPricingDecisionEvaluationFactoryLive = Layer.effect(
  CurrentPricingDecisionEvaluationFactory,
  Effect.gen(function* makeLiveFactory() {
    const externalOwnerValidation = yield* PricingExternalOwnerEvidenceValidation;
    const defaultOwnerFinalFence = yield* PricingMaterialEvidenceOwnerFinalFence;
    const catalog = yield* PricingCatalogMaterialEvidenceFenceGateway;
    const customerContext = yield* PricingCustomerContextMaterialEvidenceFenceGateway;
    const market = yield* PricingMarketMaterialEvidenceFenceGateway;
    const promotion = yield* PricingPromotionMaterialEvidenceFenceGateway;
    // A governed transaction supplies its Pricing gateway after the owner-local ports are scoped.
    return makeCurrentPricingDecisionEvaluationFactory(
      publishResolvedWithOwners(externalOwnerValidation, defaultOwnerFinalFence),
      (pricing, compositionRevision) =>
        publishResolvedWithOwners(
          externalOwnerValidation,
          makePricingMaterialEvidenceOwnerFinalFenceFromGateways(
            {
              'commerce.catalog': catalog,
              'commerce.customer-context': customerContext,
              'commerce.market-catalog': market,
              'commerce.pricing': pricing,
              'commerce.promotion': promotion,
            },
            compositionRevision,
          ),
        ),
    );
  }),
);
