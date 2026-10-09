import {
  PricingEvaluationAttemptSchema,
  PricingKnownInvalidOrConflictOutcomeSchema,
  PricingMaterialChangedSchema,
  PricingMaterialOwnerTransitionEvidenceSchema,
  PricingNonMaterialSchema,
  PricingOwnerConfirmedNonMaterialSchema,
  PricingRetryExhaustedOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import type {
  PricingEvaluationAttempt,
  PricingMaterialChangeClassification,
} from '@app/pricing-contracts/domain/material-change';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  PricingOrdinaryCurrentEvaluationAttempt,
  PricingOrdinaryCurrentWholeAttempt,
  PricingOrdinaryCurrentWholeEvaluationPort,
} from '../../src/services/ordinary-current-pricing-evaluation.service.ts';
import {
  isPricingOrdinaryCurrentEvaluationFailure,
  makePricingOrdinaryCurrentEvaluationService,
  PricingOrdinaryCurrentRetryCoherenceFailure,
} from '../../src/services/ordinary-current-pricing-evaluation.service.ts';
import { classifyPricingMaterialChange } from '../../src/services/material-change-classification.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';

const decodeSource = Schema.decodeUnknownSync(PricingSourceEvidenceResultSchema, {
  onExcessProperty: 'error',
});
const decodeAttempt = Schema.decodeUnknownSync(PricingEvaluationAttemptSchema, {
  onExcessProperty: 'error',
});
const decodeTransition = Schema.decodeUnknownSync(PricingMaterialOwnerTransitionEvidenceSchema, {
  onExcessProperty: 'error',
});

const timing = {
  1: {
    capturedAt: '2026-09-28T12:00:00.030Z',
    completedAt: '2026-09-28T12:00:00.040Z',
    observedAt: '2026-09-28T12:00:00.020Z',
    requestedAt: '2026-09-28T12:00:00.010Z',
    startedAt: '2026-09-28T12:00:00.000Z',
  },
  2: {
    capturedAt: '2026-09-28T12:00:00.080Z',
    completedAt: '2026-09-28T12:00:00.090Z',
    observedAt: '2026-09-28T12:00:00.070Z',
    requestedAt: '2026-09-28T12:00:00.060Z',
    startedAt: '2026-09-28T12:00:00.050Z',
  },
} as const;

const makeAttempt = Effect.fn('test.issue787MakeAttempt')(function* makeAttemptProgram(
  attemptOrdinal: PricingOrdinaryCurrentEvaluationAttempt,
  options?: { readonly snapshotId?: string },
) {
  const { preRound } = yield* makeIssue779PreRoundScenario();
  const { decision } = preRound;
  const clock = timing[attemptOrdinal];
  const ownerScope = {
    ownerModuleId: 'commerce.pricing',
    ownerRootRef: 'pricing:price-root:issue-787',
    predicateRef: 'price:exact:issue-787',
    tenantId: decision.tenantId,
  };
  const sourceEvidence = decodeSource({
    _tag: 'VERIFIED_ABSENT',
    completeness: {
      completenessEvidence: {
        nextApplicabilityBoundary: '2026-09-28T13:00:00.000Z',
        observedAt: clock.observedAt,
        ownerRevision: `price-set:${attemptOrdinal}`,
        scope: { kind: 'EXACT_PREDICATE', predicateRef: ownerScope.predicateRef },
      },
      currencyCode: decision.currencyCode,
      family: 'PRICE',
      ownerScope,
      ownerSetRevisionRef: `price-set:${attemptOrdinal}`,
      temporal: {
        effectiveAt: decision.operationTime,
        evaluatedAt: clock.observedAt,
        evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
        nextMaterialBoundary: '2026-09-28T13:00:00.000Z',
        observedAt: clock.observedAt,
        requestedAt: clock.requestedAt,
      },
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: `price-proof:set:${attemptOrdinal}`,
      },
    },
    request: {
      currencyCode: decision.currencyCode,
      effectiveAt: decision.operationTime,
      family: 'PRICE',
      ownerScope,
      requestedAt: clock.requestedAt,
    },
  });
  const attemptId = `pricing-attempt:${attemptOrdinal}`;
  return decodeAttempt({
    attemptId,
    attemptOrdinal,
    candidateRef,
    completedAt: clock.completedAt,
    maxAttempts: 2,
    runId: 'pricing-run:issue-787',
    snapshot: {
      attemptId,
      calculationVersions: {
        allocationContractVersions: ['pricing-allocation.v1'],
        arithmeticProfileVersions: ['pricing-arithmetic.v1'],
        publicationProfileVersions: ['pricing-publication-czk.v1'],
      },
      candidateRef,
      capturedAt: clock.capturedAt,
      decision,
      materialBindings: [
        {
          bindingRef: 'price:exact:issue-787',
          kind: 'EXACT_PRICE_SET',
          meaningRef: `price-meaning:${attemptOrdinal}`,
          sourceEvidence,
        },
      ],
      nonMaterialObservations: [
        { kind: 'STOREFRONT_ORIGIN', observationRef: `storefront:attempt:${attemptOrdinal}` },
        { kind: 'TAX_ONLY', observationRef: `tax:attempt:${attemptOrdinal}` },
      ],
      requestedAt: clock.requestedAt,
      snapshotId: options?.snapshotId ?? `pricing-snapshot:${attemptOrdinal}`,
    },
    startedAt: clock.startedAt,
  });
});

const staleClassification = (
  attempt: PricingEvaluationAttempt,
): Extract<PricingMaterialChangeClassification, { readonly _tag: 'MATERIAL_CHANGED' }> => ({
  _tag: 'MATERIAL_CHANGED',
  currentSnapshotId: attempt.snapshot.snapshotId,
  previousSnapshotId: 'pricing-snapshot:retained',
  reasons: ['CURRENCY_SUPPORT_CHANGED'],
});

const testPublication = {
  candidateRef,
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'demand-occurrence-1',
      publishedLineValue: { amount: '0', currencyCode: 'CZK' },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  pricingNetCommercialTotal: { amount: '0', currencyCode: 'CZK' },
} as const;

describe('issue #787 bounded whole-attempt retry acceptance', () => {
  it.effect('discards a stale first attempt and returns typed indeterminate exhaustion after one fresh retry', () =>
    Effect.gen(function* retriesWholeAttemptOnce() {
      const first = yield* makeAttempt(1);
      const second = yield* makeAttempt(2);
      const calls: PricingOrdinaryCurrentEvaluationAttempt[] = [];
      const source: PricingOrdinaryCurrentWholeEvaluationPort = {
        loadFresh: (attempt) => {
          calls.push(attempt);
          return Effect.succeed<PricingOrdinaryCurrentWholeAttempt>(
            attempt === 1
              ? {
                  attempt: first,
                  classification: staleClassification(first),
                  kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
                }
              : {
                  attempt: second,
                  kind: 'INDETERMINATE_OR_UNVERIFIABLE',
                  reason: 'The owner could not prove a stable second snapshot',
                },
          );
        },
      };
      const service = makePricingOrdinaryCurrentEvaluationService(source, () => Effect.succeed(testPublication));

      const failure = yield* service.evaluate.pipe(Effect.flip);

      expect(calls).toEqual([1, 2]);
      expect(Schema.is(PricingRetryExhaustedOutcomeSchema)(failure)).toBe(true);
      if (Schema.is(PricingRetryExhaustedOutcomeSchema)(failure)) {
        expect(failure.finalAttempt.attemptId).toBe(second.attemptId);
        expect(failure.finalAttempt.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
        expect(failure.finalFailure).toBe('INDETERMINATE_OR_UNVERIFIABLE');
        expect(failure.firstAttempt.attemptId).toBe(first.attemptId);
        expect(failure.firstAttempt.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
        expect(failure.firstFailure).toBe('KNOWN_STALE_OR_MATERIAL_CHANGED');
        expect(failure.retryDirective).toBe('NONE');
      }
      expect(isPricingOrdinaryCurrentEvaluationFailure(failure)).toBe(true);
    }),
  );

  it.effect('does not retry a known invalid or conflicting owner state', () =>
    Effect.gen(function* doesNotRetryKnownConflict() {
      const first = yield* makeAttempt(1);
      const calls: PricingOrdinaryCurrentEvaluationAttempt[] = [];
      const source: PricingOrdinaryCurrentWholeEvaluationPort = {
        loadFresh: (attempt) => {
          calls.push(attempt);
          return Effect.succeed({
            attempt: first,
            kind: 'KNOWN_INVALID_OR_CONFLICT' as const,
            reason: 'Exact Price key has two Current revisions',
          });
        },
      };
      const service = makePricingOrdinaryCurrentEvaluationService(source, () => Effect.succeed(testPublication));

      const failure = yield* service.evaluate.pipe(Effect.flip);

      expect(calls).toEqual([1]);
      expect(Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(failure)).toBe(true);
      if (Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(failure)) {
        expect(failure.reason).toBe('Exact Price key has two Current revisions');
        expect(failure.retryDirective).toBe('NONE');
      }
    }),
  );

  it.effect('rejects a retry that reuses the discarded snapshot instead of rebuilding the whole attempt', () =>
    Effect.gen(function* rejectsSnapshotReuse() {
      const first = yield* makeAttempt(1);
      const secondWithReusedSnapshot = yield* makeAttempt(2, { snapshotId: first.snapshot.snapshotId });
      const source: PricingOrdinaryCurrentWholeEvaluationPort = {
        loadFresh: (attempt) =>
          Effect.succeed(
            attempt === 1
              ? {
                  attempt: first,
                  kind: 'INDETERMINATE_OR_UNVERIFIABLE' as const,
                  reason: 'First owner read changed',
                }
              : {
                  attempt: secondWithReusedSnapshot,
                  kind: 'INDETERMINATE_OR_UNVERIFIABLE' as const,
                  reason: 'Second owner read changed',
                },
          ),
      };
      const service = makePricingOrdinaryCurrentEvaluationService(source, () => Effect.succeed(testPublication));

      const failure = yield* service.evaluate.pipe(Effect.flip);

      expect(Schema.is(PricingOrdinaryCurrentRetryCoherenceFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({
        reason: 'FRESH_RETRY_COHERENCE_UNVERIFIABLE',
        retryable: true,
      });
    }),
  );
});

describe('issue #787 owner-confirmed materiality acceptance', () => {
  it.effect('keeps Storefront and Tax-only observations outside Pricing monetary materiality', () =>
    Effect.gen(function* ignoresNonMonetaryObservations() {
      const previous = yield* makeAttempt(1);
      const nextAttempt = yield* makeAttempt(2);
      const current = {
        ...previous.snapshot,
        attemptId: nextAttempt.attemptId,
        capturedAt: nextAttempt.snapshot.capturedAt,
        nonMaterialObservations: [
          { kind: 'STOREFRONT_ORIGIN' as const, observationRef: 'storefront:brand-b' },
          { kind: 'TAX_ONLY' as const, observationRef: 'tax-revision:changed' },
        ],
        snapshotId: nextAttempt.snapshot.snapshotId,
      };

      const classification = classifyPricingMaterialChange({
        current,
        ownerTransitions: [],
        previous: previous.snapshot,
      });
      expect(Schema.is(PricingNonMaterialSchema)(classification)).toBe(true);
      if (Schema.is(PricingNonMaterialSchema)(classification)) {
        expect(classification.currentSnapshotId).toBe(current.snapshotId);
        expect(classification.previousSnapshotId).toBe(previous.snapshot.snapshotId);
        expect(classification.reason).toBe('STOREFRONT_OR_TAX_ONLY');
      }
    }),
  );

  it.effect(
    'requires the full owner-bound transition proof for changed evidence even when weak cues look unchanged',
    () =>
      Effect.gen(function* requiresOwnerConfirmation() {
        const previousAttempt = yield* makeAttempt(1);
        const nextAttempt = yield* makeAttempt(2);
        const [previousBinding] = previousAttempt.snapshot.materialBindings;
        if (
          previousBinding === undefined ||
          !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(previousBinding.sourceEvidence)
        ) {
          throw new Error('Issue #787 fixture requires one verified-absent exact Price binding');
        }
        const previousEvidence = previousBinding.sourceEvidence;
        const currentEvidence = decodeSource({
          ...previousEvidence,
          completeness: {
            ...previousEvidence.completeness,
            completenessEvidence: {
              ...previousEvidence.completeness.completenessEvidence,
              ownerRevision: 'price-set:owner-confirmed-successor',
            },
            ownerSetRevisionRef: 'price-set:owner-confirmed-successor',
            verification: {
              kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
              verificationRef: 'price-proof:set:owner-confirmed-successor',
            },
          },
        });
        const currentBinding = {
          ...previousBinding,
          sourceEvidence: currentEvidence,
        };
        const current = {
          ...previousAttempt.snapshot,
          attemptId: nextAttempt.attemptId,
          capturedAt: nextAttempt.snapshot.capturedAt,
          materialBindings: [currentBinding],
          snapshotId: nextAttempt.snapshot.snapshotId,
        };

        const unconfirmed = classifyPricingMaterialChange({
          current,
          ownerTransitions: [],
          previous: previousAttempt.snapshot,
        });
        expect(Schema.is(PricingMaterialChangedSchema)(unconfirmed)).toBe(true);
        if (Schema.is(PricingMaterialChangedSchema)(unconfirmed)) {
          expect(unconfirmed.reasons).toEqual(['EXACT_PRICE_KEY_OR_SET_CHANGED']);
        }

        const transition = decodeTransition({
          bindingRef: previousBinding.bindingRef,
          confirmedAt: nextAttempt.completedAt,
          currentEvidence,
          currentSnapshotId: current.snapshotId,
          family: previousEvidence.request.family,
          ownerScope: previousEvidence.request.ownerScope,
          previousEvidence,
          previousSnapshotId: previousAttempt.snapshot.snapshotId,
          transitionRef: 'owner-transition:meaning-preserved:issue-787',
          verification: {
            kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION',
            verificationRef: 'owner-proof:transition:meaning-preserved:issue-787',
          },
        });

        const confirmed = classifyPricingMaterialChange({
          current,
          ownerTransitions: [transition],
          previous: previousAttempt.snapshot,
        });
        expect(Schema.is(PricingOwnerConfirmedNonMaterialSchema)(confirmed)).toBe(true);
        if (Schema.is(PricingOwnerConfirmedNonMaterialSchema)(confirmed)) {
          expect(confirmed.currentSnapshotId).toBe(current.snapshotId);
          expect(confirmed.previousSnapshotId).toBe(previousAttempt.snapshot.snapshotId);
        }
      }),
  );
});
