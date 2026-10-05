import { Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { AvailabilityOwnerEvidenceUnavailable } from '../../shared/domain/availability-owner-ports.ts';
import {
  makeChangedCurrentnessInput,
  makeCurrentnessInput,
  materialPositionChanges,
} from '../support/availability-currentness.ts';
import {
  acceptanceLater,
  acceptanceObservedAt,
  currentRequest,
  evaluateCurrent,
  ownerProof,
} from '../support/availability-owner-acceptance.ts';

const ControlledReservationRejected = Schema.TaggedError<Error>()('ControlledReservationRejected', {
  reason: Schema.Literal('GUARANTEE_UNAVAILABLE'),
});

const valid = (input: Parameters<typeof ownerProof>[0], boundary: Parameters<typeof ownerProof>[1]) =>
  Effect.succeed(ownerProof(input, boundary));

const base = makeCurrentnessInput(['3'], '2');

describe('Availability owner acceptance: currentness and immutable history', () => {
  it.effect(
    'scenario 13: retained owner-valid evidence survives source outage, while STALE and event silence do not authorize purchase',
    () =>
      Effect.gen(function* retainedCurrent() {
        const original = (yield* evaluateCurrent(
          currentRequest(base),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        let reads = 0;
        const retained = yield* evaluateCurrent(
          currentRequest(base, original),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
          () => {
            reads += 1;
            return Effect.fail(new AvailabilityOwnerEvidenceUnavailable({ owner: 'INVENTORY' }));
          },
        );
        expect(reads).toBe(0);
        expect(retained.currentDecision.decision.outcome).toBe('AVAILABLE');
        expect(retained.currentDecision.currentness).toBe('OWNER_VERIFIED_CURRENT');
        expect(retained.bundleDisposition).toBe('UNCHANGED');
        const stale = { ...base, ownerQualification: { ...base.ownerQualification, currentness: 'STALE' as const } };
        const staleResult = yield* evaluateCurrent(
          currentRequest(stale),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          stale,
        );
        expect(staleResult.currentDecision.decision.outcome).toBe('INDETERMINATE');
        expect(staleResult.currentDecision.decision.reasons).toContain('STALE');
        const silent = yield* evaluateCurrent(
          currentRequest(base, original),
          () => Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'NO_OWNER_VALIDITY_PROOF_DESPITE_EVENT_SILENCE' }),
          base,
        );
        expect(silent.currentDecision.decision.outcome).toBe('INDETERMINATE');
        expect(silent.currentDecision.currentnessReasons).toContain('NO_OWNER_VALIDITY_PROOF_DESPITE_EVENT_SILENCE');
      }),
  );

  it.effect(
    'scenario 14: old positive Cart evidence is revalidated at final Checkout against changed actual facts',
    () =>
      Effect.gen(function* checkout() {
        const original = (yield* evaluateCurrent(
          currentRequest(base, undefined, 'INFORMATIONAL'),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        const changed = makeChangedCurrentnessInput('BINDING');
        let verifications = 0;
        const result = yield* evaluateCurrent(
          currentRequest(changed, original, 'CHECKOUT_SUBMISSION'),
          ({ evidence, useBoundary }) => {
            verifications += 1;
            return verifications === 1
              ? Effect.succeed({ _tag: 'INVALID' as const, reason: 'BINDING_CHANGED' })
              : Effect.succeed(ownerProof(evidence, useBoundary, 'R2'));
          },
          changed,
        );
        expect(verifications).toBe(2);
        expect(result.currentDecision.decision.outcome).toBe('UNAVAILABLE');
        expect(result.currentDecision.decision.useBoundary.kind).toBe('CHECKOUT_SUBMISSION');
        expect(result.currentDecision.decision.evidence.stockInput).toEqual(changed.stockInput);
        expect(result.originalDecision?.decision.outcome).toBe('AVAILABLE');
        expect(result.originalDecision?.decision.useBoundary.kind).toBe('INFORMATIONAL');
      }),
  );

  it.effect(
    'scenario 15: recent Checkout AVAILABLE is not a positive commitment gate without proof for actual Order Commitment use',
    () =>
      Effect.gen(function* commitment() {
        const checkout = (yield* evaluateCurrent(
          currentRequest(base, undefined, 'CHECKOUT_SUBMISSION'),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        const result = yield* evaluateCurrent(
          currentRequest(base, checkout),
          ({ evidence }) =>
            Effect.succeed(ownerProof(evidence, { kind: 'CHECKOUT_SUBMISSION', requiredAt: acceptanceObservedAt })),
          base,
        );
        expect(checkout.decision.outcome).toBe('AVAILABLE');
        expect(result.currentDecision.decision.outcome).toBe('INDETERMINATE');
        expect(result.currentDecision.currentness).toBe('INDETERMINATE');
        expect(result.currentDecision.decision.useBoundary).toEqual({
          kind: 'ORDER_COMMITMENT',
          requiredAt: acceptanceLater,
        });
        expect(result.originalDecision).toEqual(checkout);
      }),
  );

  it.effect(
    'scenario 16: changed Bundle-contained R2 requires replacement without patching original Attempt, even if outcome stays AVAILABLE',
    () =>
      Effect.gen(function* replacement() {
        const original = (yield* evaluateCurrent(
          currentRequest(base),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        const originalAttempt = Object.freeze({ attemptRef: 'attempt-R1', availability: original });
        const changed = makeChangedCurrentnessInput('POSITION_INSERT');
        let verifications = 0;
        const result = yield* evaluateCurrent(
          currentRequest(changed, original),
          ({ evidence, useBoundary }) => {
            verifications += 1;
            return verifications === 1
              ? Effect.succeed({ _tag: 'INVALID' as const, reason: 'POSITION_INSERT' })
              : Effect.succeed(ownerProof(evidence, useBoundary, 'R2'));
          },
          changed,
        );
        expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
        expect(result.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
        expect(result.currentDecision.decision.evidence.stockInput.positions).toHaveLength(2);
        expect(originalAttempt.availability.decision.evidence.stockInput.positions).toHaveLength(1);
        expect(result.originalDecision).toEqual(originalAttempt.availability);
        expect(originalAttempt.availability.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R1']);
        expect(Object.isFrozen(originalAttempt.availability.decision.evidence.stockInput.positions)).toBe(true);
      }),
  );

  it.effect(
    'scenario 17: later Reservation failure preserves positive historical Availability and supplies no Confirmation or Commitment Protection',
    () =>
      Effect.gen(function* reservationFailure() {
        const historical = (yield* evaluateCurrent(
          currentRequest(base),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        const reservation = yield* Effect.fail(
          new ControlledReservationRejected({ reason: 'GUARANTEE_UNAVAILABLE' }),
        ).pipe(Effect.result);
        expect(Result.isFailure(reservation)).toBe(true);
        expect(historical.decision.outcome).toBe('AVAILABLE');
        expect(historical.currentness).toBe('OWNER_VERIFIED_CURRENT');
        expect(Object.hasOwn(historical, 'reservation')).toBe(false);
        expect(Object.hasOwn(historical, 'confirmation')).toBe(false);
        expect(Object.hasOwn(historical, 'commitmentProtection')).toBe(false);
        expect(Object.isFrozen(historical)).toBe(true);
      }),
  );

  it.effect('scenario 25: owner-valid original R1 remains Current despite current source publishing R2', () =>
    Effect.gen(function* validRevision() {
      const original = (yield* evaluateCurrent(
        currentRequest(base),
        ({ evidence, useBoundary }) => valid(evidence, useBoundary),
        base,
      )).currentDecision;
      const sourceR2 = makeChangedCurrentnessInput('POSITION_INSERT');
      let currentReads = 0;
      const result = yield* evaluateCurrent(
        currentRequest(base, original),
        ({ evidence, useBoundary }) => {
          expect(evidence.stockInput).toEqual(original.decision.evidence.stockInput);
          return Effect.succeed(ownerProof(evidence, useBoundary, 'R1'));
        },
        sourceR2,
        () => {
          currentReads += 1;
          return Effect.succeed(sourceR2);
        },
      );
      expect(currentReads).toBe(0);
      expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
      expect(result.currentDecision.currentness).toBe('OWNER_VERIFIED_CURRENT');
      expect(result.currentDecision.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R1']);
      expect(result.bundleDisposition).toBe('UNCHANGED');
    }),
  );

  for (const change of materialPositionChanges) {
    it.effect(`scenario 26: owner-invalid R1 is replaced by actual owner-valid R2 after ${change}`, () =>
      Effect.gen(function* invalidRevision() {
        const original = (yield* evaluateCurrent(
          currentRequest(base),
          ({ evidence, useBoundary }) => valid(evidence, useBoundary),
          base,
        )).currentDecision;
        const changed = makeChangedCurrentnessInput(change);
        let verifications = 0;
        let reads = 0;
        const result = yield* evaluateCurrent(
          currentRequest(changed, original),
          ({ evidence, useBoundary }) => {
            verifications += 1;
            if (verifications === 1) {
              expect(evidence.stockInput).toEqual(original.decision.evidence.stockInput);
              return Effect.succeed({ _tag: 'INVALID' as const, reason: change });
            }
            expect(evidence.stockInput).toEqual(changed.stockInput);
            return Effect.succeed(ownerProof(evidence, useBoundary, 'R2'));
          },
          changed,
          () => {
            reads += 1;
            return Effect.succeed(changed);
          },
        );
        expect(reads).toBe(1);
        expect(verifications).toBe(2);
        expect(result.currentDecision.decision.outcome).toBe(
          {
            BINDING: 'UNAVAILABLE',
            COMPLETENESS_LOST: 'INDETERMINATE',
            LIFECYCLE: 'UNAVAILABLE',
            POSITION_INSERT: 'AVAILABLE',
            POSITION_REMOVE: 'UNAVAILABLE',
            SHARING: 'UNAVAILABLE',
          }[change],
        );
        expect(result.currentDecision.decision.evidence.ownerQualification.set).toEqual(changed.ownerQualification.set);
        expect(result.currentDecision.decision.evidence.stockInput).toEqual(changed.stockInput);
        expect(result.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
        expect(result.originalDecision).toEqual(original);
      }),
    );
  }

  it.effect(
    'scenario 26: evaluation race rereads a whole coherent snapshot and bounded failure stays INDETERMINATE',
    () =>
      Effect.gen(function* evaluationRace() {
        const changed = makeChangedCurrentnessInput('BINDING');
        let reads = 0;
        let verifications = 0;
        const result = yield* evaluateCurrent(
          currentRequest(base),
          ({ evidence, useBoundary }) => {
            verifications += 1;
            return verifications === 1
              ? Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'EVIDENCE_CHANGED_DURING_EVALUATION' })
              : Effect.succeed(ownerProof(evidence, useBoundary, 'R2'));
          },
          base,
          () => {
            reads += 1;
            return Effect.succeed(reads === 1 ? base : changed);
          },
        );
        expect(reads).toBe(2);
        expect(verifications).toBe(2);
        expect(result.currentDecision.decision.outcome).toBe('UNAVAILABLE');
        expect(result.currentDecision.decision.evidence.stockInput).toEqual(changed.stockInput);
        let unsuccessfulProofs = 0;
        const indeterminate = yield* evaluateCurrent(
          currentRequest(base),
          () => {
            unsuccessfulProofs += 1;
            return Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'MIXED_R1_R2' });
          },
          base,
        );
        expect(unsuccessfulProofs).toBe(2);
        expect(indeterminate.currentDecision.decision.outcome).toBe('INDETERMINATE');
        expect(indeterminate.currentDecision.currentnessReasons).toContain('MIXED_R1_R2');
      }),
  );
});
