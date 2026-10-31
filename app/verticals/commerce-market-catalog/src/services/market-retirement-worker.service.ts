import type {
  OutboxWorkerCompletionPublicationError,
  OutboxWorkerLegalEntityScopeError,
} from '@app/core-runtime/outbox/worker';
import { Context, DateTime, Effect, Match, Option, Result } from 'effect';

import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import type { MarketRetirementOutcome } from '../../shared/domain/market-retirement-intent.ts';
import type { OutboxPayload } from '../../shared/outbox/commerce-market-catalog-market-retirement-requested-v1.ts';
import type {
  MarketRetirementImpactFailure,
  MarketRetirementWorkerStep,
} from '../domain/market-retirement-workflow.ts';
import {
  hasLiveBlockingReferences,
  marketRetirementIdempotencyKey,
  marketRetirementOutcome,
  nextMarketRetirementStep,
  terminalFailureReason,
  validateRetirementAssessment,
} from '../domain/market-retirement-workflow.ts';
import type { MarketAdministrationPersistenceUnavailable } from '../persistence/market-administration-persistence.ts';
import type {
  MarketRetirementAdvanceCommand,
  MarketRetirementAdvanceOutcome,
  MarketRetirementIntentSnapshot,
  MarketRetirementStageChange,
} from '../persistence/market-retirement-intent-persistence.ts';
import type { MarketRetirementOwnerCallContext } from './market-retirement-impact-authority.ts';
import { MarketRetirementWorkerPending } from './market-retirement-worker-pending.ts';
import { MarketRetirementImpactAuthorityService } from './market-retirement-impact-authority.ts';

export type MarketRetirementIntentStoreFailure =
  | MarketAdministrationPersistenceUnavailable
  | MarketRetirementWorkerPending
  | OutboxWorkerCompletionPublicationError
  | OutboxWorkerLegalEntityScopeError;

/** The verified Outbox delivery whose exact Tenant and Legal Entity scope owns the intent. */
export interface MarketRetirementDelivery {
  readonly context: OutboxWorkerHandlerContext;
  readonly payload: OutboxPayload;
}

/** Owner state for one intent. Each call is one short owner transaction; no remote call runs inside it. */
export interface MarketRetirementIntentStore {
  readonly advance: (
    delivery: MarketRetirementDelivery,
    command: MarketRetirementAdvanceCommand,
  ) => Effect.Effect<MarketRetirementAdvanceOutcome, MarketRetirementIntentStoreFailure>;
  readonly read: (
    delivery: MarketRetirementDelivery,
  ) => Effect.Effect<Option.Option<MarketRetirementIntentSnapshot>, MarketRetirementIntentStoreFailure>;
}

export class MarketRetirementIntentStoreService extends Context.Service<
  MarketRetirementIntentStoreService,
  MarketRetirementIntentStore
>()('@app/commerce-market-catalog/services/market-retirement-worker.service/MarketRetirementIntentStoreService') {}

export interface MarketRetirementWorkerInput {
  readonly delivery: MarketRetirementDelivery;
  /** True on the delivery's last attempt: an assessment that never became available fails the intent. */
  readonly finalAttempt: boolean;
}

/** Enough for REQUESTED -> COMPLETED or FAILED plus one stale compare-and-set re-read. */
const MAX_STEPS = 8;

const pending = (reason: string, cause?: unknown) => {
  const failure = new MarketRetirementWorkerPending({ code: 'market_retirement_pending', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const invalid = (reason: string) =>
  new MarketRetirementWorkerPending({ code: 'market_retirement_intent_invalid', reason });

const recordedAt = DateTime.now;

/**
 * Drives one durable intent to a terminal state: RESERVE -> local retirement -> COMMIT, or RELEASE of a
 * never-committed reservation. Remote calls are idempotent per intent and operation; owner writes are
 * compare-and-set on the observed stage, so duplicate deliveries and stale claimants converge.
 */
export const completeMarketRetirement = Effect.fn('MarketRetirementWorker.complete')(function* complete(
  input: MarketRetirementWorkerInput,
) {
  const store = yield* MarketRetirementIntentStoreService;
  const authority = yield* MarketRetirementImpactAuthorityService;
  const { context, payload } = input.delivery;
  const { marketRef } = payload;
  const owner: MarketRetirementOwnerCallContext = {
    compositionRevision: context.compositionRevision,
    legalEntityId: payload.legalEntityId,
    requestCorrelation: context.correlationId ?? context.messageId,
  };
  const advance = Effect.fnUntraced(function* advanceIntent(command: MarketRetirementStageChange) {
    const outcome = yield* store.advance(input.delivery, {
      ...command,
      intentId: payload.retirementIntentId,
      recordedAt: yield* recordedAt,
    });
    return yield* Match.value(outcome).pipe(
      Match.tags({
        advanced: ({ intent }) => Effect.succeed(intent),
        unchanged: ({ intent }) => Effect.succeed(intent),
      }),
      Match.orElse(() => Effect.fail(invalid(`The retirement intent rejected the ${command.operation} stage change`))),
    );
  });
  const failOrRetry = (
    failure: MarketRetirementImpactFailure,
    expectedStage: 'REQUESTED' | 'RESERVATION_REQUESTED',
    allowUnavailableTerminal: boolean,
  ) => {
    const reason =
      terminalFailureReason(failure) ?? (allowUnavailableTerminal ? 'impact_assessment_unavailable' : undefined);
    return reason === undefined
      ? Effect.fail(pending('Customer Context did not give a definite retirement-impact outcome', failure))
      : advance({ expectedStage, failureReason: reason, operation: 'RECORD_FAILED' });
  };

  const prepareReservation = (intent: MarketRetirementIntentSnapshot) =>
    authority
      .prepareRetirementReservation({
        ...owner,
        effectiveAt: intent.effectiveAt,
        expectedMarketRevision: intent.expectedRevision,
        marketRef,
        reason: intent.reason,
      })
      .pipe(
        Effect.tap(({ assessment }) => validateRetirementAssessment(intent, marketRef, assessment)),
        Effect.result,
        Effect.flatMap(
          Result.match({
            // Read only: nothing is reserved yet, so a definite or exhausted failure ends the intent.
            onFailure: (failure) => failOrRetry(failure, 'REQUESTED', input.finalAttempt),
            onSuccess: ({ assessment, reservationRequest }) =>
              hasLiveBlockingReferences(assessment)
                ? advance({
                    expectedStage: 'REQUESTED',
                    failureReason: 'replacement_impact_unresolved',
                    operation: 'RECORD_FAILED',
                  })
                : advance({
                    expectedStage: 'REQUESTED',
                    operation: 'RECORD_RESERVATION_REQUEST',
                    reservationRequest,
                    retirementImpactAssessment: assessment,
                  }),
          }),
        ),
      );

  const reserve = (
    intent: MarketRetirementIntentSnapshot,
    step: Extract<MarketRetirementWorkerStep, { readonly kind: 'reserve' }>,
  ) =>
    authority
      .reserveRetirementImpact({
        ...owner,
        assessment: step.assessment,
        idempotencyKey: marketRetirementIdempotencyKey(intent.intentId, 'reserve'),
        reservationRequest: step.reservationRequest,
      })
      .pipe(
        Effect.result,
        Effect.flatMap(
          Result.match({
            // A definite RESERVE rejection rolled back Customer Context's transaction: no reservation exists.
            onFailure: (failure) => failOrRetry(failure, 'RESERVATION_REQUESTED', false),
            onSuccess: (reserved) =>
              advance({
                expectedStage: 'RESERVATION_REQUESTED',
                operation: 'RECORD_RESERVATION',
                retirementImpactAssessment: reserved,
              }),
          }),
        ),
      );

  const runStep = (intent: MarketRetirementIntentSnapshot, step: MarketRetirementWorkerStep) =>
    Match.value(step).pipe(
      Match.discriminatorsExhaustive('kind')({
        commit: ({ assessment }) =>
          // The Market is already retired: COMMIT is retried until it succeeds and is never replaced by RELEASE.
          authority
            .commitRetirementImpact({
              ...owner,
              assessment,
              idempotencyKey: marketRetirementIdempotencyKey(intent.intentId, 'commit'),
              reason: intent.reason,
            })
            .pipe(
              Effect.mapError((failure) => pending('Customer Context has not committed the reservation', failure)),
              Effect.andThen(advance({ expectedStage: 'COMMIT_PENDING', operation: 'RECORD_COMPLETED' })),
            ),
        done: () => Effect.succeed(intent),
        invalid: ({ reason }) => Effect.fail(invalid(reason)),
        prepare_reservation: () => prepareReservation(intent),
        release: ({ assessment }) =>
          authority
            .releaseRetirementImpact({
              ...owner,
              assessment,
              idempotencyKey: marketRetirementIdempotencyKey(intent.intentId, 'release'),
              reason: intent.reason,
            })
            .pipe(
              Effect.mapError((failure) => pending('Customer Context has not released the reservation', failure)),
              Effect.andThen(
                advance({
                  expectedStage: 'RELEASE_PENDING',
                  failureReason: intent.failureReason ?? 'impact_assessment_rejected',
                  operation: 'RECORD_FAILED',
                }),
              ),
            ),
        reserve: (reserveStep) => reserve(intent, reserveStep),
        // Local Market retirement and its market-retired.v1 completion commit together, or the intent moves to
        // RELEASE_PENDING with the typed local rejection.
        transition: () => advance({ expectedStage: 'RESERVED', operation: 'TRANSITION' }),
      }),
    );

  const drive = (
    remaining: number,
  ): Effect.Effect<
    MarketRetirementOutcome,
    MarketRetirementIntentStoreFailure | MarketRetirementImpactFailure | MarketRetirementWorkerPending
  > =>
    store.read(input.delivery).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(invalid('The requested Market retirement intent does not exist in the trusted scope')),
          onSome: (intent) => {
            const step = nextMarketRetirementStep(intent);
            if (step.kind === 'done') {
              return Effect.succeed(marketRetirementOutcome(intent, marketRef));
            }
            return remaining === 0
              ? Effect.fail(pending('The Market retirement intent did not reach a terminal stage in one delivery'))
              : runStep(intent, step).pipe(Effect.andThen(Effect.suspend(() => drive(remaining - 1))));
          },
        }),
      ),
    );
  return yield* drive(MAX_STEPS);
});
