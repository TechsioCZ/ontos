import type { PricingCommercialTotalSafeProjection } from '@app/pricing-contracts/domain/commercial-total';
import {
  PricingCurrentnessEvaluationOutcomeSchema,
  PricingEvaluationAttemptIdSchema,
  PricingEvaluationAttemptSchema,
  PricingFreshAttemptOutcomeSchema,
  PricingKnownInvalidOrConflictOutcomeSchema,
  PricingMaterialSnapshotIdSchema,
  PricingRetryExhaustedOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import type {
  PricingCurrentnessEvaluationOutcome,
  PricingEvaluationAttempt,
  PricingMaterialChangeClassification,
} from '@app/pricing-contracts/domain/material-change';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Context, Effect, Schema } from 'effect';

import type {
  PricingOrdinaryCurrentPublicationIndeterminate,
  PricingOrdinaryCurrentPublicationRequest,
} from './ordinary-current-pricing-publication.service.ts';

export type PricingOrdinaryCurrentEvaluationAttempt = 1 | 2;

interface PricingOrdinaryCurrentWholeAttemptReady<PublicationRequest = PricingOrdinaryCurrentPublicationRequest> {
  readonly attempt: PricingEvaluationAttempt;
  readonly kind: 'READY_FOR_FINAL_PUBLICATION';
  /** One complete, coherent request. No field from another attempt may be substituted into it. */
  readonly publicationRequest: PublicationRequest;
}

interface PricingOrdinaryCurrentWholeAttemptKnownStale {
  readonly attempt: PricingEvaluationAttempt;
  readonly classification: Extract<PricingMaterialChangeClassification, { readonly _tag: 'MATERIAL_CHANGED' }>;
  readonly kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED';
}

interface PricingOrdinaryCurrentWholeAttemptKnownInvalid {
  readonly attempt: PricingEvaluationAttempt;
  readonly kind: 'KNOWN_INVALID_OR_CONFLICT';
  readonly reason: string;
}

interface PricingOrdinaryCurrentWholeAttemptIndeterminate {
  readonly attempt: PricingEvaluationAttempt;
  readonly kind: 'INDETERMINATE_OR_UNVERIFIABLE';
  readonly reason: string;
}

export type PricingOrdinaryCurrentWholeAttempt<PublicationRequest = PricingOrdinaryCurrentPublicationRequest> =
  | PricingOrdinaryCurrentWholeAttemptIndeterminate
  | PricingOrdinaryCurrentWholeAttemptKnownInvalid
  | PricingOrdinaryCurrentWholeAttemptKnownStale
  | PricingOrdinaryCurrentWholeAttemptReady<PublicationRequest>;

/**
 * Owner-integrated whole-evaluation capability. Every invocation must reread and recalculate all
 * material state into one new attempt; it must never cache or patch an earlier publication request.
 */
export interface PricingOrdinaryCurrentWholeEvaluationPort<
  PublicationRequest = PricingOrdinaryCurrentPublicationRequest,
> {
  readonly loadFresh: (
    attempt: PricingOrdinaryCurrentEvaluationAttempt,
  ) => Effect.Effect<PricingOrdinaryCurrentWholeAttempt<PublicationRequest>>;
}

class PricingOrdinaryCurrentWholeEvaluation extends Context.Service<
  PricingOrdinaryCurrentWholeEvaluation,
  PricingOrdinaryCurrentWholeEvaluationPort
>()('@app/pricing/services/ordinary-current-pricing-evaluation.service/PricingOrdinaryCurrentWholeEvaluation') {}

export interface PricingOrdinaryCurrentPublished<Publication = PricingCommercialTotalSafeProjection> {
  /** Only the accepted attempt is retained; discarded attempt evidence is intentionally absent. */
  readonly acceptedAttempt: PricingEvaluationAttempt;
  readonly attempts: PricingOrdinaryCurrentEvaluationAttempt;
  readonly currentness: Extract<PricingCurrentnessEvaluationOutcome, { readonly _tag: 'FRESH' }>;
  readonly outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED';
  readonly publication: Publication;
}

type PricingOrdinaryCurrentEvaluationFailure = Exclude<
  PricingCurrentnessEvaluationOutcome,
  | { readonly _tag: 'FRESH' }
  | { readonly _tag: 'KNOWN_STALE_OR_MATERIAL_CHANGED' }
  | {
      readonly _tag: 'INDETERMINATE_OR_UNVERIFIABLE';
    }
>;

/** A second load occurred, but it was not a distinct coherent attempt in the same bounded run. */
export class PricingOrdinaryCurrentRetryCoherenceFailure extends Schema.TaggedError<PricingOrdinaryCurrentRetryCoherenceFailure>()(
  'PricingOrdinaryCurrentRetryCoherenceFailure',
  {
    candidateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
    firstAttemptId: PricingEvaluationAttemptIdSchema,
    firstSnapshotId: PricingMaterialSnapshotIdSchema,
    reason: Schema.Literal('FRESH_RETRY_COHERENCE_UNVERIFIABLE'),
    retryable: Schema.Literal(true),
    secondAttemptId: PricingEvaluationAttemptIdSchema,
    secondSnapshotId: PricingMaterialSnapshotIdSchema,
  },
) {}

export type PricingOrdinaryCurrentTerminalFailure =
  | PricingOrdinaryCurrentEvaluationFailure
  | PricingOrdinaryCurrentRetryCoherenceFailure;

export interface PricingOrdinaryCurrentEvaluationService<
  Requirements = never,
  Publication = PricingCommercialTotalSafeProjection,
> {
  readonly evaluate: Effect.Effect<
    PricingOrdinaryCurrentPublished<Publication>,
    PricingOrdinaryCurrentTerminalFailure,
    Requirements
  >;
}

class PricingOrdinaryCurrentEvaluation extends Context.Service<
  PricingOrdinaryCurrentEvaluation,
  PricingOrdinaryCurrentEvaluationService
>()('@app/pricing/services/ordinary-current-pricing-evaluation.service/PricingOrdinaryCurrentEvaluation') {}

type Publish<Requirements = never> = (
  request: PricingOrdinaryCurrentPublicationRequest,
) => Effect.Effect<PricingCommercialTotalSafeProjection, PricingOrdinaryCurrentPublicationIndeterminate, Requirements>;

type GenericPublish<PublicationRequest, Publication = PricingCommercialTotalSafeProjection, Requirements = never> = (
  request: PublicationRequest,
) => Effect.Effect<Publication, PricingOrdinaryCurrentPublicationIndeterminate, Requirements>;

interface PricingBoundedWholeAttemptEvaluationDependencies<
  PublicationRequest,
  Publication = PricingCommercialTotalSafeProjection,
  Requirements = never,
> {
  readonly publish: GenericPublish<PublicationRequest, Publication, Requirements>;
  readonly requestBindsAttempt: (attempt: PricingEvaluationAttempt, request: PublicationRequest) => boolean;
}

const RetryableFailureKindSchema = Schema.Literals([
  'INDETERMINATE_OR_UNVERIFIABLE',
  'KNOWN_STALE_OR_MATERIAL_CHANGED',
]);
type RetryableFailureKind = typeof RetryableFailureKindSchema.Type;
type KnownInvalidFailure = Extract<PricingCurrentnessEvaluationOutcome, { readonly _tag: 'KNOWN_INVALID_OR_CONFLICT' }>;

interface RetryableAttemptFailure {
  readonly attempt: PricingEvaluationAttempt;
  readonly kind: RetryableFailureKind;
  readonly reason: string;
}

const attemptIsValid = (
  attempt: PricingEvaluationAttempt,
  expectedOrdinal: PricingOrdinaryCurrentEvaluationAttempt,
): boolean => Schema.is(PricingEvaluationAttemptSchema)(attempt) && attempt.attemptOrdinal === expectedOrdinal;

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);

const attemptBindsRequest = (
  attempt: PricingEvaluationAttempt,
  request: PricingOrdinaryCurrentPublicationRequest,
): boolean =>
  attempt.candidateRef === request.materialEvidence.commercialTotal.candidateRef &&
  attempt.snapshot.candidateRef === request.materialEvidence.commercialTotal.candidateRef &&
  sameDecision(attempt.snapshot.decision, request.materialEvidence.commercialTotal.decision);

const malformedAttempt = (attempt: PricingEvaluationAttempt, detail: string): RetryableAttemptFailure => ({
  attempt,
  kind: 'INDETERMINATE_OR_UNVERIFIABLE',
  reason: detail,
});

const publicationFailure = (
  attempt: PricingEvaluationAttempt,
  failure: PricingOrdinaryCurrentPublicationIndeterminate,
): KnownInvalidFailure | RetryableAttemptFailure => {
  if (failure.reasonCode === 'KNOWN_INVALID_OR_CONFLICT') {
    return {
      _tag: 'KNOWN_INVALID_OR_CONFLICT',
      attempt,
      reason: failure.safeDetail,
      retryDirective: 'NONE',
    };
  }
  return {
    attempt,
    kind:
      failure.reasonCode === 'MATERIAL_EVIDENCE_CHANGED'
        ? 'KNOWN_STALE_OR_MATERIAL_CHANGED'
        : 'INDETERMINATE_OR_UNVERIFIABLE',
    reason: failure.safeDetail,
  };
};

const retryableAttemptFailure = <PublicationRequest>(
  result: PricingOrdinaryCurrentWholeAttempt<PublicationRequest>,
): KnownInvalidFailure | RetryableAttemptFailure | undefined => {
  if (result.kind === 'KNOWN_INVALID_OR_CONFLICT') {
    return {
      _tag: 'KNOWN_INVALID_OR_CONFLICT',
      attempt: result.attempt,
      reason: result.reason,
      retryDirective: 'NONE',
    };
  }
  if (result.kind === 'KNOWN_STALE_OR_MATERIAL_CHANGED') {
    return {
      attempt: result.attempt,
      kind: result.kind,
      reason: result.classification.reasons.join(', '),
    };
  }
  if (result.kind === 'INDETERMINATE_OR_UNVERIFIABLE') {
    return { attempt: result.attempt, kind: result.kind, reason: result.reason };
  }
  return undefined;
};

const attemptsFormOneRun = (first: PricingEvaluationAttempt, second: PricingEvaluationAttempt): boolean =>
  first.attemptOrdinal === 1 &&
  second.attemptOrdinal === 2 &&
  first.runId === second.runId &&
  first.candidateRef === second.candidateRef &&
  first.attemptId !== second.attemptId &&
  first.snapshot.snapshotId !== second.snapshot.snapshotId &&
  first.completedAt <= second.startedAt;

const exhausted = (
  first: RetryableAttemptFailure,
  final: RetryableAttemptFailure,
): PricingOrdinaryCurrentTerminalFailure => {
  const outcome = {
    _tag: 'RETRY_EXHAUSTED' as const,
    finalAttempt: final.attempt,
    finalFailure: final.kind,
    firstAttempt: first.attempt,
    firstFailure: first.kind,
    reason: `Ordinary Current Pricing did not stabilize after two coherent attempts: ${final.reason}`,
    retryDirective: 'NONE' as const,
  };
  return Schema.is(PricingRetryExhaustedOutcomeSchema)(outcome)
    ? outcome
    : new PricingOrdinaryCurrentRetryCoherenceFailure({
        candidateRef: first.attempt.candidateRef,
        firstAttemptId: first.attempt.attemptId,
        firstSnapshotId: first.attempt.snapshot.snapshotId,
        reason: 'FRESH_RETRY_COHERENCE_UNVERIFIABLE',
        retryable: true,
        secondAttemptId: final.attempt.attemptId,
        secondSnapshotId: final.attempt.snapshot.snapshotId,
      });
};

const coherenceFailure = (
  first: RetryableAttemptFailure,
  second: PricingEvaluationAttempt,
): PricingOrdinaryCurrentRetryCoherenceFailure =>
  new PricingOrdinaryCurrentRetryCoherenceFailure({
    candidateRef: first.attempt.candidateRef,
    firstAttemptId: first.attempt.attemptId,
    firstSnapshotId: first.attempt.snapshot.snapshotId,
    reason: 'FRESH_RETRY_COHERENCE_UNVERIFIABLE',
    retryable: true,
    secondAttemptId: second.attemptId,
    secondSnapshotId: second.snapshot.snapshotId,
  });

/**
 * Runs at most two complete attempts. Only a fully fresh second request can follow a retryable
 * first result, and only the accepted request is published or returned.
 */
export const makePricingBoundedWholeAttemptEvaluationService = <
  PublicationRequest,
  Publication = PricingCommercialTotalSafeProjection,
  Requirements = never,
>(
  source: PricingOrdinaryCurrentWholeEvaluationPort<PublicationRequest>,
  dependencies: PricingBoundedWholeAttemptEvaluationDependencies<PublicationRequest, Publication, Requirements>,
): PricingOrdinaryCurrentEvaluationService<Requirements, Publication> => ({
  evaluate: Effect.gen(function* evaluateOrdinaryCurrentPricing() {
    const runAttempt = Effect.fn('PricingOrdinaryCurrentEvaluation.runAttempt')(function* runWholeAttempt(
      ordinal: PricingOrdinaryCurrentEvaluationAttempt,
    ) {
      const result = yield* source.loadFresh(ordinal);
      if (!attemptIsValid(result.attempt, ordinal)) {
        return {
          failure: malformedAttempt(
            result.attempt,
            'Whole Pricing evaluation returned malformed metadata or the wrong attempt ordinal',
          ),
        } as const;
      }
      const prePublicationFailure = retryableAttemptFailure(result);
      if (prePublicationFailure !== undefined) {
        return { failure: prePublicationFailure } as const;
      }
      if (
        result.kind !== 'READY_FOR_FINAL_PUBLICATION' ||
        !dependencies.requestBindsAttempt(result.attempt, result.publicationRequest)
      ) {
        return {
          failure: malformedAttempt(
            result.attempt,
            'Whole Pricing evaluation request does not bind its exact coherent attempt snapshot',
          ),
        } as const;
      }
      const published = yield* dependencies.publish(result.publicationRequest).pipe(
        Effect.match({
          onFailure: (failure) => ({ failure: publicationFailure(result.attempt, failure) }),
          onSuccess: (publication) => ({ attempt: result.attempt, publication }),
        }),
      );
      return published;
    });

    const first = yield* runAttempt(1);
    if ('publication' in first) {
      const currentness = {
        _tag: 'FRESH' as const,
        attempt: first.attempt,
        retryDirective: 'NONE' as const,
      };
      if (!Schema.is(PricingFreshAttemptOutcomeSchema)(currentness)) {
        return yield* Effect.fail(
          exhausted(
            malformedAttempt(first.attempt, 'Accepted first attempt has invalid currentness evidence'),
            malformedAttempt(first.attempt, 'Accepted first attempt has invalid currentness evidence'),
          ),
        );
      }
      return {
        acceptedAttempt: first.attempt,
        attempts: 1 as const,
        currentness,
        outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED' as const,
        publication: first.publication,
      };
    }
    if (Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(first.failure)) {
      return yield* Effect.fail(first.failure);
    }

    const second = yield* runAttempt(2);
    const secondAttempt = 'publication' in second ? second.attempt : second.failure.attempt;
    if (!attemptsFormOneRun(first.failure.attempt, secondAttempt)) {
      return yield* coherenceFailure(first.failure, secondAttempt);
    }
    if ('publication' in second) {
      const currentness = {
        _tag: 'FRESH' as const,
        attempt: second.attempt,
        retryDirective: 'NONE' as const,
      };
      return {
        acceptedAttempt: second.attempt,
        attempts: 2 as const,
        currentness,
        outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED' as const,
        publication: second.publication,
      };
    }
    if (Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(second.failure)) {
      return yield* Effect.fail(second.failure);
    }
    return yield* Effect.fail(exhausted(first.failure, second.failure));
  }),
});

export const makePricingOrdinaryCurrentEvaluationService = (
  source: PricingOrdinaryCurrentWholeEvaluationPort,
  publish: Publish,
): PricingOrdinaryCurrentEvaluationService =>
  PricingOrdinaryCurrentEvaluation.of(
    makePricingBoundedWholeAttemptEvaluationService(PricingOrdinaryCurrentWholeEvaluation.of(source), {
      publish,
      requestBindsAttempt: attemptBindsRequest,
    }),
  );

export const isPricingOrdinaryCurrentEvaluationFailure = (input: PricingOrdinaryCurrentTerminalFailure): boolean =>
  Schema.is(PricingCurrentnessEvaluationOutcomeSchema)(input) ||
  Schema.is(PricingOrdinaryCurrentRetryCoherenceFailure)(input);
