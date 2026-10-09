import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import type { PricingEvaluationAttempt } from '@app/pricing-contracts/domain/material-change';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  PricingOrdinaryCurrentWholeAttempt,
  PricingOrdinaryCurrentWholeEvaluationPort,
} from '../../src/services/ordinary-current-pricing-evaluation.service.ts';
import {
  makePricingBoundedWholeAttemptEvaluationService,
  PricingOrdinaryCurrentRetryCoherenceFailure,
} from '../../src/services/ordinary-current-pricing-evaluation.service.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';

const decodeAttempt = Schema.decodeUnknownSync(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeAttempt = (ordinal: 1 | 2): PricingEvaluationAttempt => {
  const clock =
    ordinal === 1
      ? {
          capturedAt: '2026-09-28T10:00:00.400Z',
          completedAt: '2026-09-28T10:00:00.500Z',
          evaluatedAt: '2026-09-28T10:00:00.200Z',
          observedAt: '2026-09-28T10:00:00.300Z',
          requestedAt: '2026-09-28T10:00:00.100Z',
          startedAt: '2026-09-28T10:00:00.000Z',
        }
      : {
          capturedAt: '2026-09-28T10:00:00.900Z',
          completedAt: '2026-09-28T10:00:01.000Z',
          evaluatedAt: '2026-09-28T10:00:00.700Z',
          observedAt: '2026-09-28T10:00:00.800Z',
          requestedAt: '2026-09-28T10:00:00.600Z',
          startedAt: '2026-09-28T10:00:00.550Z',
        };
  const attemptId = `attempt-${ordinal}`;
  const snapshot = makeIssue787Snapshot({
    attemptId,
    capturedAt: clock.capturedAt,
    evaluatedAt: clock.evaluatedAt,
    observedAt: clock.observedAt,
    requestedAt: clock.requestedAt,
    revision: `${ordinal}`,
    snapshotId: `snapshot-${ordinal}`,
  });
  return decodeAttempt({
    attemptId,
    attemptOrdinal: ordinal,
    candidateRef: snapshot.candidateRef,
    completedAt: clock.completedAt,
    maxAttempts: 2,
    runId: 'run-787-success',
    snapshot,
    startedAt: clock.startedAt,
  });
};

interface TestPublicationRequest {
  readonly candidateRef: string;
  readonly marker: 'B';
  readonly snapshotId: string;
}

const publication = {
  candidateRef: 'candidate-787',
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'line-a',
      publishedLineValue: { amount: '100', currencyCode: 'CZK' },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  pricingNetCommercialTotal: { amount: '100', currencyCode: 'CZK' },
} as const;

describe('ordinary Current Pricing bounded evaluation', () => {
  it.effect('preserves a caller-owned publication result without narrowing it to the customer projection', () =>
    Effect.gen(function* preservesGenericPublication() {
      const attempt = makeAttempt(1);
      const source: PricingOrdinaryCurrentWholeEvaluationPort<TestPublicationRequest> = {
        loadFresh: () =>
          Effect.succeed({
            attempt,
            kind: 'READY_FOR_FINAL_PUBLICATION' as const,
            publicationRequest: {
              candidateRef: attempt.candidateRef,
              marker: 'B' as const,
              snapshotId: attempt.snapshot.snapshotId,
            },
          }),
      };
      const service = makePricingBoundedWholeAttemptEvaluationService<
        TestPublicationRequest,
        { readonly exactOutcome: 'FULL_EVIDENCE_RETAINED' }
      >(source, {
        publish: () => Effect.succeed({ exactOutcome: 'FULL_EVIDENCE_RETAINED' as const }),
        requestBindsAttempt: (currentAttempt, request) =>
          currentAttempt.candidateRef === request.candidateRef &&
          currentAttempt.snapshot.snapshotId === request.snapshotId,
      });

      const result = yield* service.evaluate;

      expect(result.publication).toEqual({ exactOutcome: 'FULL_EVIDENCE_RETAINED' });
    }),
  );

  it.effect('discards A whole and publishes only the distinct coherent B retry', () =>
    Effect.gen(function* discardsAttemptA() {
      const first = makeAttempt(1);
      const second = makeAttempt(2);
      const requests: TestPublicationRequest[] = [];
      const source: PricingOrdinaryCurrentWholeEvaluationPort<TestPublicationRequest> = {
        loadFresh: (ordinal) =>
          Effect.succeed<PricingOrdinaryCurrentWholeAttempt<TestPublicationRequest>>(
            ordinal === 1
              ? {
                  attempt: first,
                  classification: {
                    _tag: 'MATERIAL_CHANGED',
                    currentSnapshotId: first.snapshot.snapshotId,
                    previousSnapshotId: 'snapshot-before-run',
                    reasons: ['EXACT_PRICE_KEY_OR_SET_CHANGED'],
                  },
                  kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
                }
              : {
                  attempt: second,
                  kind: 'READY_FOR_FINAL_PUBLICATION',
                  publicationRequest: {
                    candidateRef: second.candidateRef,
                    marker: 'B',
                    snapshotId: second.snapshot.snapshotId,
                  },
                },
          ),
      };
      const service = makePricingBoundedWholeAttemptEvaluationService(source, {
        publish: (request) => {
          requests.push(request);
          return Effect.succeed(publication);
        },
        requestBindsAttempt: (attempt, request) =>
          attempt.candidateRef === request.candidateRef && attempt.snapshot.snapshotId === request.snapshotId,
      });

      const result = yield* service.evaluate;
      const encodedResult = yield* encodeJson(result);

      expect(requests).toEqual([{ candidateRef: second.candidateRef, marker: 'B', snapshotId: 'snapshot-2' }]);
      expect(result.attempts).toBe(2);
      expect(result.acceptedAttempt.attemptId).toBe('attempt-2');
      expect(result.acceptedAttempt.snapshot.snapshotId).toBe('snapshot-2');
      expect(result).not.toHaveProperty('firstAttempt');
      expect(encodedResult).not.toContain('attempt-1');
      expect(encodedResult).not.toContain('snapshot-1');
    }),
  );

  it.effect('rejects second-attempt known-invalid output that reuses the discarded attempt and snapshot IDs', () =>
    Effect.gen(function* rejectsReusedRetryIdentity() {
      const first = makeAttempt(1);
      const second = makeAttempt(2);
      const reused = {
        ...second,
        attemptId: first.attemptId,
        snapshot: {
          ...second.snapshot,
          attemptId: first.attemptId,
          snapshotId: first.snapshot.snapshotId,
        },
      } satisfies PricingEvaluationAttempt;
      const source: PricingOrdinaryCurrentWholeEvaluationPort<TestPublicationRequest> = {
        loadFresh: (ordinal) =>
          Effect.succeed(
            ordinal === 1
              ? {
                  attempt: first,
                  kind: 'INDETERMINATE_OR_UNVERIFIABLE' as const,
                  reason: 'First owner snapshot changed',
                }
              : {
                  attempt: reused,
                  kind: 'KNOWN_INVALID_OR_CONFLICT' as const,
                  reason: 'Second snapshot reports an exact-key conflict',
                },
          ),
      };
      const service = makePricingBoundedWholeAttemptEvaluationService(source, {
        publish: () => Effect.succeed(publication),
        requestBindsAttempt: () => true,
      });

      const failure = yield* service.evaluate.pipe(Effect.flip);

      expect(Schema.is(PricingOrdinaryCurrentRetryCoherenceFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({
        firstAttemptId: first.attemptId,
        firstSnapshotId: first.snapshot.snapshotId,
        reason: 'FRESH_RETRY_COHERENCE_UNVERIFIABLE',
        secondAttemptId: first.attemptId,
        secondSnapshotId: first.snapshot.snapshotId,
      });
    }),
  );

  it.effect('rejects second-attempt known-invalid output that switches the run and candidate', () =>
    Effect.gen(function* rejectsSwitchedRetryRun() {
      const first = makeAttempt(1);
      const second = makeAttempt(2);
      const switched = {
        ...second,
        candidateRef: 'candidate-787-other',
        runId: 'run-787-other',
        snapshot: { ...second.snapshot, candidateRef: 'candidate-787-other' },
      } satisfies PricingEvaluationAttempt;
      const source: PricingOrdinaryCurrentWholeEvaluationPort<TestPublicationRequest> = {
        loadFresh: (ordinal) =>
          Effect.succeed(
            ordinal === 1
              ? {
                  attempt: first,
                  classification: {
                    _tag: 'MATERIAL_CHANGED' as const,
                    currentSnapshotId: first.snapshot.snapshotId,
                    previousSnapshotId: 'snapshot-before-run',
                    reasons: ['PRICE_SCHEDULE_BOUNDARY_CROSSED' as const],
                  },
                  kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED' as const,
                }
              : {
                  attempt: switched,
                  kind: 'KNOWN_INVALID_OR_CONFLICT' as const,
                  reason: 'Second snapshot reports an exact-key conflict',
                },
          ),
      };
      const service = makePricingBoundedWholeAttemptEvaluationService(source, {
        publish: () => Effect.succeed(publication),
        requestBindsAttempt: () => true,
      });

      const failure = yield* service.evaluate.pipe(Effect.flip);

      expect(Schema.is(PricingOrdinaryCurrentRetryCoherenceFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({
        candidateRef: first.candidateRef,
        firstAttemptId: first.attemptId,
        reason: 'FRESH_RETRY_COHERENCE_UNVERIFIABLE',
        secondAttemptId: second.attemptId,
      });
      expect(failure).not.toHaveProperty('retryDirective');
    }),
  );
});
