import type { ReserveMarketRetirementPayload } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import { DateTime, Effect, Match, Predicate, Schema } from 'effect';

import type { MarketCommandRejected } from '../../shared/action-contracts.ts';
import { MarketRetirementPendingStageSchema } from '../../shared/domain/market-retirement-intent.ts';
import type {
  MarketRetirementFailureReason,
  MarketRetirementOutcome,
  MarketRetirementRemoteOperation,
} from '../../shared/domain/market-retirement-intent.ts';
import { ReservedMarketRetirementImpactAssessmentSchema } from '../../shared/domain/market-retirement-impact.ts';
import type {
  MarketRetirementImpactAssessment,
  MarketRetirementProviderAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import type { MarketRef } from '../../shared/resources/market.ts';
import { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import type { MarketRetirementIntentSnapshot } from '../persistence/market-retirement-intent-persistence.ts';

type ReserveRequest = Extract<ReserveMarketRetirementPayload, { readonly operation: 'RESERVE' }>;

/**
 * Market retirement state machine.
 *
 * REQUESTED -> RESERVATION_REQUESTED -> RESERVED -> COMMIT_PENDING -> COMPLETED
 *                    |                      \-> RELEASE_PENDING -> FAILED
 *                    \-> FAILED (definite Customer Context rejection before any reservation exists)
 *
 * Every remote Customer Context call happens between two short owner transactions. A COMMITTED reservation is
 * never released: once the Market is retired (COMMIT_PENDING) the only way forward is COMMIT.
 */
export type MarketRetirementWorkerStep =
  | Readonly<{ assessment: ReservedMarketRetirementImpactAssessment; kind: 'commit' }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'invalid'; reason: string }>
  | Readonly<{ kind: 'prepare_reservation' }>
  | Readonly<{ assessment: ReservedMarketRetirementImpactAssessment; kind: 'release' }>
  | Readonly<{ assessment: MarketRetirementImpactAssessment; kind: 'reserve'; reservationRequest: ReserveRequest }>
  | Readonly<{ kind: 'transition' }>;

export type MarketRetirementImpactFailure =
  | MarketCommandRejected
  | MarketRetirementImpactAssessmentRejected
  | MarketRetirementImpactAssessmentStale
  | MarketRetirementImpactAssessmentUnavailable;

const isReservedAssessment = Schema.is(ReservedMarketRetirementImpactAssessmentSchema);

const withReservation = (
  intent: MarketRetirementIntentSnapshot,
  step: (assessment: ReservedMarketRetirementImpactAssessment) => MarketRetirementWorkerStep,
  missing: string,
): MarketRetirementWorkerStep =>
  isReservedAssessment(intent.retirementImpactAssessment)
    ? step(intent.retirementImpactAssessment)
    : { kind: 'invalid', reason: missing };

const reserveStep = (intent: MarketRetirementIntentSnapshot): MarketRetirementWorkerStep => {
  const { reservationRequest, retirementImpactAssessment } = intent;
  return retirementImpactAssessment === undefined || reservationRequest?.operation !== 'RESERVE'
    ? { kind: 'invalid', reason: 'A requested reservation has no persisted exact RESERVE request' }
    : { assessment: retirementImpactAssessment, kind: 'reserve', reservationRequest };
};

export const nextMarketRetirementStep = (intent: MarketRetirementIntentSnapshot): MarketRetirementWorkerStep =>
  Match.value(intent.stage).pipe(
    Match.when('REQUESTED', (): MarketRetirementWorkerStep => ({ kind: 'prepare_reservation' })),
    Match.when('RESERVATION_REQUESTED', () => reserveStep(intent)),
    Match.when('RESERVED', () =>
      withReservation(intent, () => ({ kind: 'transition' }), 'A reserved retirement has no reservation evidence'),
    ),
    Match.when('COMMIT_PENDING', () =>
      withReservation(
        intent,
        (assessment) => ({ assessment, kind: 'commit' }),
        'A retired Market has no reservation to commit',
      ),
    ),
    Match.when('RELEASE_PENDING', () =>
      withReservation(
        intent,
        (assessment) => ({ assessment, kind: 'release' }),
        'A failed retirement has no reservation to release',
      ),
    ),
    Match.whenOr('COMPLETED', 'FAILED', (): MarketRetirementWorkerStep => ({ kind: 'done' })),
    Match.exhaustive,
  );

/** Stable per intent and operation, so every retry and duplicate delivery replays the same owner request. */
export const marketRetirementIdempotencyKey = (intentId: string, operation: MarketRetirementRemoteOperation) =>
  `market-retirement:${intentId}:${operation}`;

/**
 * Definite Customer Context outcomes become terminal failure reasons. `undefined` means the failure is not
 * proven definite (transport, unavailability, unknown) and the worker must retry with the same key.
 */
export const terminalFailureReason = (
  failure: MarketRetirementImpactFailure,
): MarketRetirementFailureReason | undefined => {
  if (Predicate.isTagged(failure, 'MarketCommandRejected')) {
    return 'replacement_impact_unresolved';
  }
  if (Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentRejected')) {
    return 'impact_assessment_rejected';
  }
  if (Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentStale')) {
    return 'impact_assessment_stale';
  }
  return undefined;
};

const isPendingStage = Schema.is(MarketRetirementPendingStageSchema);

const definitionRevisionRef = (tenantId: string, resourceId: string) =>
  ({
    moduleId: 'commerce.market-catalog',
    resourceId,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  }) as const;

/** The public view of one intent, shared by the retire Action result and the status read. */
export const marketRetirementOutcome = (
  intent: MarketRetirementIntentSnapshot,
  marketRef: MarketRef,
): MarketRetirementOutcome => {
  if (intent.stage === 'COMPLETED' && intent.retiredRevision !== undefined) {
    return {
      changed: intent.transitionChanged ?? true,
      definitionRevisionRef: definitionRevisionRef(
        intent.tenantId,
        intent.retiredDefinitionRevisionId ?? intent.expectedDefinitionRevisionId,
      ),
      lifecycle: 'RETIRED',
      marketRef,
      outcome: 'completed',
      retirementIntentId: intent.intentId,
      revision: intent.retiredRevision,
    };
  }
  if (intent.stage === 'FAILED' && intent.failureReason !== undefined) {
    return { marketRef, outcome: 'failed', reason: intent.failureReason, retirementIntentId: intent.intentId };
  }
  return {
    marketRef,
    outcome: 'pending',
    retirementIntentId: intent.intentId,
    stage: isPendingStage(intent.stage) ? intent.stage : 'COMMIT_PENDING',
  };
};

const unavailableAssessment = (reason: string) =>
  new MarketRetirementImpactAssessmentUnavailable({ code: 'market_retirement_impact_assessment_unavailable', reason });

const staleAssessment = (reason: string) =>
  new MarketRetirementImpactAssessmentStale({ code: 'market_retirement_impact_assessment_stale', reason });

const refsMatch = (left: MarketRef, right: MarketRef) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const validateProviderSet = (
  assessment: MarketRetirementImpactAssessment,
): Effect.Effect<void, MarketRetirementImpactAssessmentUnavailable> => {
  const requiredOwners = new Set(assessment.requiredProviderModuleKeys);
  const assessedOwners = new Set(assessment.providers.map(({ ownerModuleKey }) => ownerModuleKey));
  return requiredOwners.size !== assessment.requiredProviderModuleKeys.length ||
    assessedOwners.size !== assessment.providers.length ||
    requiredOwners.size !== assessedOwners.size ||
    [...requiredOwners].some((owner) => !assessedOwners.has(owner))
    ? Effect.fail(unavailableAssessment('The authoritative Market retirement inventory is missing a required owner'))
    : Effect.void;
};

const validateProviderCurrentness = (
  provider: MarketRetirementProviderAssessment,
  effectiveAt: string,
): Effect.Effect<void, MarketRetirementImpactAssessmentStale | MarketRetirementImpactAssessmentUnavailable> => {
  if (provider.effectiveAt !== effectiveAt) {
    return Effect.fail(staleAssessment('A provider assessed Market retirement for a different effective instant'));
  }
  if (provider.nextBoundaryAt !== undefined && provider.nextBoundaryAt <= effectiveAt) {
    return Effect.fail(staleAssessment('A provider retirement-impact assessment crossed its next material boundary'));
  }
  if (
    provider.completenessEvidenceReference.length === 0 ||
    provider.currentnessEvidenceReference.length === 0 ||
    provider.ownerRevision.length === 0 ||
    provider.versionToken.length === 0
  ) {
    return Effect.fail(
      unavailableAssessment('A provider did not supply complete owner-verifiable retirement evidence'),
    );
  }
  return Effect.void;
};

/** Binds owner impact evidence to the exact intent: Market, revision, instant, complete provider inventory. */
export const validateRetirementAssessment = Effect.fn('MarketRetirementWorkflow.validateAssessment')(function* validate(
  intent: MarketRetirementIntentSnapshot,
  marketRef: MarketRef,
  assessment: MarketRetirementImpactAssessment,
) {
  if (!refsMatch(assessment.assessedMarketRef, marketRef)) {
    return yield* new MarketRetirementImpactAssessmentRejected({
      code: 'market_retirement_impact_assessment_rejected',
      reason: 'The Market retirement assessment belongs to another Market',
    });
  }
  if (assessment.assessedMarketRevision !== intent.expectedRevision) {
    return yield* staleAssessment('The Market changed after owner impact evidence was requested');
  }
  const effectiveAt = DateTime.formatIso(intent.effectiveAt);
  if (assessment.effectiveAt !== effectiveAt) {
    return yield* staleAssessment('The retirement effective instant changed after owner impact evidence was requested');
  }
  yield* validateProviderSet(assessment);
  yield* Effect.forEach(assessment.providers, (provider) => validateProviderCurrentness(provider, effectiveAt), {
    concurrency: 1,
    discard: true,
  });
  return assessment;
});

export const hasLiveBlockingReferences = (assessment: MarketRetirementImpactAssessment): boolean =>
  assessment.providers.some(({ liveBlockingReferences }) => liveBlockingReferences.count > 0);
