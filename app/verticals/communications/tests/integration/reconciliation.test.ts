import { DateTime, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { fixtureType } from '../unit/support/catalog-fixtures.ts';
import { privacyAllowed, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { decideOne, historyOf, ingest, intentHistoryOf, targetOf } from '../support/history-world.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  answers,
  attemptsOf,
  conflictsOf,
  crashAfterProviderCall,
  kindOf,
  observationsOf,
  reconcileOnly,
  reconcileThenStep,
  recoverableType,
  recoveriesOf,
  resolutionsOf,
  retryLinksOf,
  stepWith,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/**
 * [#1403 Reconciliation] An uncertain external effect pauses everything; step 22 evidence (a LABELLED DOUBLE here: no real step
 * 22 exists) is appended as observations through the one input contract of the history. Nothing is deleted or edited, and the
 * original indeterminate answer stays next to the proof.
 */
const sequence = (...scripted: readonly (() => ReturnType<typeof answers.accepted>)[]) => {
  let index = 0;
  return handoffDouble(() => {
    const answer = scripted[Math.min(index, scripted.length - 1)] ?? answers.accepted;
    index += 1;
    return answer();
  });
};

/** A world with one intent whose first attempt timed out: its effect is unknown. */
const unknownEffect = Effect.fn('ReconciliationTest.unknownEffect')(function* unknown(
  types = [recoverableType()],
  firstAnswer = answers.timeout,
) {
  const world = yield* setup({ types });
  const handoff = sequence(firstAnswer, answers.accepted);
  const { intentId, requestId } = yield* decideOne(world);
  yield* stepWith(world, handoff, intentId);
  const [first] = yield* attemptsOf(world, intentId);
  const target = targetOf(world, intentId, first?.attemptId ?? '');
  const now = yield* DateTime.now;
  return { first, handoff, intentId, now, requestId, target, world };
});

describe('Reconciliation of an uncertain provider effect (#1403)', () => {
  it.live('[S04 AC-02] nothing is submitted while the effect is unknown, however often the message is delivered', () =>
    Effect.gen(function* paused() {
      const { handoff, intentId, requestId, world } = yield* unknownEffect();
      for (let delivery = 0; delivery < 3; delivery += 1) {
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
      }
      expect(handoff.calls).toHaveLength(1);
      expect((yield* intentHistoryOf(world, requestId)).history.summary.status).toBe('INDETERMINATE');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S05 AC-02 R-05] a reconciliation that PROVES acceptance is recorded as such: the send is never repeated, now or later',
    () =>
      Effect.gen(function* provenAcceptance() {
        const { handoff, intentId, now, requestId, target, world } = yield* unknownEffect();
        const outcome = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.acceptanceProven(target, { key: 'r-1', observedAt: now }),
        ]);
        expect(outcome.reconciliation.answers).toEqual(['RECORDED']);
        expect(outcome.processing).toMatchObject({ kind: 'SKIPPED', reason: 'ALREADY_FINISHED' });
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_FINISHED');
        expect(handoff.calls).toHaveLength(1);
        // the original indeterminate answer stays, and the acceptance is one more fact
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind)).toEqual(['ACCEPTANCE_PROVEN']);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ providerAccepted: true, status: 'PROVIDER_ACCEPTED' });
        expect(yield* retryLinksOf(world, intentId)).toEqual([]);
        // reconciled acceptance is acceptance of the SUBMISSION, never delivery
        expect(record.history.summary.deliveryProven).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S06 AC-02 R-04] a reconciliation that PROVES non-acceptance lets the SAME intent continue after FRESH Current gates; the indeterminate answer and the proof both stay',
    () =>
      Effect.gen(function* provenNonAcceptance() {
        const { first, handoff, intentId, now, requestId, target, world } = yield* unknownEffect();
        const queriesBefore = world.privacy.queries.length;
        const outcome = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now }),
        ]);
        expect(outcome.processing.kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(2);
        // fresh gates: Privacy was asked AGAIN, never answered from an earlier ALLOWED
        expect(world.privacy.queries.length).toBeGreaterThan(queriesBefore);
        const attempts = yield* attemptsOf(world, intentId);
        expect(attempts.map(({ state }) => state)).toEqual(['INDETERMINATE', 'ACCEPTED']);
        const [observation] = yield* observationsOf(world, intentId);
        expect(observation).toMatchObject({ attemptId: first?.attemptId, kind: 'NON_ACCEPTANCE_PROVEN' });
        expect(yield* retryLinksOf(world, intentId)).toMatchObject([
          {
            attemptId: attempts[1]?.attemptId,
            basisKind: 'RECONCILED_NON_ACCEPTANCE',
            basisObservationId: observation?.observationId,
            previousAttemptId: first?.attemptId,
          },
        ]);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('PROVIDER_ACCEPTED');
        // the unknown first answer is still its own entry of the timeline, next to the proof
        expect(record.history.entries.filter(({ technical }) => technical === 'ACCEPTANCE_INDETERMINATE')).toHaveLength(
          1,
        );
        expect(
          record.history.entries.filter(({ observationKind }) => observationKind === 'NON_ACCEPTANCE_PROVEN'),
        ).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S03 R-04 AC-07] a proven non-acceptance without an approved recovery rule is recorded as a halt: nothing is sent, the source owner decides',
    () =>
      Effect.gen(function* noRule() {
        const { handoff, intentId, now, requestId, target, world } = yield* unknownEffect([fixtureType()]);
        const outcome = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now }),
        ]);
        expect(outcome.processing).toMatchObject({ code: 'NO_RECOVERY_RULE', kind: 'HALTED' });
        expect(handoff.calls).toHaveLength(1);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([{ code: 'NO_RECOVERY_RULE', outcome: 'HALTED' }]);
        expect((yield* historyOf(world, requestId)).feed.messages[0]).toMatchObject({
          attention: 'FAILURE',
          reason: 'NO_RECOVERY_RULE',
          status: 'FAILED',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S13 R-06] Current Privacy after the reconciliation decides: a proven prohibition stops the continuation and the original answer stays',
    () =>
      Effect.gen(function* privacyAfterReconciliation() {
        const { handoff, intentId, now, target, world } = yield* unknownEffect();
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        const outcome = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now }),
        ]);
        expect(outcome.processing).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_NOT_ALLOWED', proven: true }],
        });
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { code: 'PRIVACY_NOT_ALLOWED', outcome: 'STOPPED', proven: true },
        ]);
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[H-07] contradictory reconciliation (a non-acceptance AND an acceptance) is never resolved in favour of sending',
    () =>
      Effect.gen(function* contradictory() {
        const { handoff, intentId, now, requestId, target, world } = yield* unknownEffect();
        const outcome = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now }),
          step22Double.acceptanceProven(target, { key: 'r-2', observedAt: now }),
        ]);
        expect(outcome.processing).toMatchObject({ kind: 'SKIPPED', reason: 'RECONCILIATION_REQUIRED' });
        expect(handoff.calls).toHaveLength(1);
        expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
          contradictory: true,
          status: 'INDETERMINATE',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('evidence that names another Tenant or another intent is never bound and changes nothing', () =>
    Effect.gen(function* foreignEvidence() {
      const { handoff, intentId, now, target, world } = yield* unknownEffect();
      const other = yield* setup({ types: [recoverableType()] });
      const foreign = yield* decideOne(other);
      const outcome = yield* reconcileThenStep(world, handoff, intentId, [
        step22Double.nonAcceptanceProven({ ...target, tenantId: other.tenantId }, { key: 'r-1', observedAt: now }),
        step22Double.nonAcceptanceProven({ ...target, intentId: foreign.intentId }, { key: 'r-2', observedAt: now }),
      ]);
      expect(outcome.reconciliation.answers).toEqual(['UNBOUND', 'UNBOUND']);
      expect(outcome.processing).toMatchObject({ kind: 'SKIPPED', reason: 'RECONCILIATION_REQUIRED' });
      expect(yield* observationsOf(world, intentId)).toEqual([]);
      expect(handoff.calls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[H-07] a conflict of provider evidence blocks the retry until a later reconciliation SETTLES it by an appended resolution; the conflict and every observation stay',
    () =>
      Effect.gen(function* conflictResolution() {
        const { handoff, intentId, now, requestId, target, world } = yield* unknownEffect();
        // the same observation identity arrives again with another content: a conflict, the first fact untouched
        const firstProof = step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: now });
        const later = DateTime.add(now, { minutes: 5 });
        expect(yield* ingest(world, firstProof)).toBe('RECORDED');
        expect(yield* ingest(world, step22Double.nonAcceptanceProven(target, { key: 'r-1', observedAt: later }))).toBe(
          'CONFLICT',
        );
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect((yield* intentHistoryOf(world, requestId)).history.summary.needsReconciliation).toBe(true);
        expect(handoff.calls).toHaveLength(1);
        // an attempt to settle it with the very same evidence (not a LATER reconciliation) settles nothing
        expect((yield* reconcileOnly(world, intentId, [firstProof])).resolvedConflicts).toBe(0);
        // a later reconciliation of the same attempt settles it, by appending a resolution
        const settled = yield* reconcileThenStep(world, handoff, intentId, [
          step22Double.nonAcceptanceProven(target, { key: 'r-2', observedAt: later }),
        ]);
        expect(settled.reconciliation.resolvedConflicts).toBe(1);
        expect(settled.processing.kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(2);
        // nothing was deleted: the conflict, both observations and the resolution are all there
        expect(yield* conflictsOf(world, intentId)).toHaveLength(1);
        expect(yield* observationsOf(world, intentId)).toHaveLength(2);
        const [resolution] = yield* resolutionsOf(world, intentId);
        const [conflict] = yield* conflictsOf(world, intentId);
        expect(resolution).toMatchObject({
          conflictId: conflict?.conflictId,
          reasonCode: 'RECONCILED_BY_PROVIDER_EVIDENCE',
        });
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.needsReconciliation).toBe(false);
        expect(record.history.entries.filter(({ kind }) => kind === 'OBSERVATION_CONFLICTED')).toHaveLength(1);
        // and the same settlement is idempotent
        expect(
          (yield* reconcileOnly(world, intentId, [
            step22Double.nonAcceptanceProven(target, { key: 'r-2', observedAt: later }),
          ])).resolvedConflicts,
        ).toBe(0);
        expect(yield* resolutionsOf(world, intentId)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-14] an attempt whose provider call happened and whose evidence was never recorded is closed as unanswered ONLY by a reconciliation that proves non-acceptance, then continues',
    () =>
      Effect.gen(function* unfinishedAttempt() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = sequence(answers.accepted);
        const { intentId } = yield* decideOne(world);
        yield* crashAfterProviderCall(world, handoff, intentId);
        expect(handoff.calls).toHaveLength(1);
        const [prepared] = yield* attemptsOf(world, intentId);
        expect(prepared).toMatchObject({ state: 'PREPARED' });
        const target = targetOf(world, intentId, prepared?.attemptId ?? '');
        const now = yield* DateTime.now;
        // an acceptance reconciliation does NOT close it: the answer stays unknown and the attempt stays PREPARED
        const accepted = yield* reconcileOnly(world, intentId, [
          step22Double.acceptanceProven(target, { key: 'a-1', observedAt: now }),
        ]);
        expect(accepted.closedAttempts).toBe(0);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_FINISHED');

        const second = yield* setup({ types: [recoverableType()] });
        const secondHandoff = sequence(answers.accepted);
        const { intentId: secondId } = yield* decideOne(second);
        yield* crashAfterProviderCall(second, secondHandoff, secondId);
        const [unfinished] = yield* attemptsOf(second, secondId);
        const proof = step22Double.nonAcceptanceProven(targetOf(second, secondId, unfinished?.attemptId ?? ''), {
          key: 'n-1',
          observedAt: now,
        });
        const outcome = yield* reconcileThenStep(second, secondHandoff, secondId, [proof]);
        expect(outcome.reconciliation.closedAttempts).toBe(1);
        expect(outcome.processing.kind).toBe('HANDED_OFF');
        expect((yield* attemptsOf(second, secondId)).map(({ state }) => state)).toEqual(['INDETERMINATE', 'ACCEPTED']);
        expect((yield* attemptsOf(second, secondId))[0]?.evidence).toMatchObject({
          kind: 'INDETERMINATE',
          reason: 'no_answer_recorded',
        });
        expect(secondHandoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
