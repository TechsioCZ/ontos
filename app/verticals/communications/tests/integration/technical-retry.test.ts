import { Effect, Exit, Redacted, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { communicationRequests } from '../../src/database/schema.ts';
import { requireRedeliveryWhenRetryDue } from '../../src/handoff/process-intent-handoff.ts';
import { attemptIdOf } from '../../src/domain/intake/identity.ts';
import type { ProviderEvidenceCase } from '../../src/domain/handoff/message-handoff.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import {
  deactivateRevision,
  invalidateRevisionAsUnsafe,
  resolveTemplatePin,
} from '../../src/services/template-revision-domain.service.ts';
import { fixtureType } from '../unit/support/catalog-fixtures.ts';
import { privacyAllowed, privacyIndeterminate, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { ORIGINAL_ADDRESS, unusable } from '../unit/support/recipient-fixtures.ts';
import { decideOne, historyOf, intentHistoryOf } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld, templateBase } from '../support/intake-world.ts';
import { actorWith, makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  answers,
  attemptsOf,
  crashAfterProviderCall,
  intentRowOf,
  kindOf,
  recoverableType,
  recoveriesOf,
  retryLinksOf,
  stepWith,
  stopsOf,
} from '../support/recovery-world.ts';

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/**
 * [#1403 Technical Retry] A later attempt of the SAME intent, on native PostgreSQL as the runtime role and through the REAL
 * scoped routines. The Messaging Adapter is a labelled double that records every call, so "no second external attempt" is a
 * measured fact. Nothing here is provider evidence or production delivery (that is #1411 with a real step 22).
 */

/** A provider double that answers by the number of the call it receives: the first call gets `first`, the rest `later`. */
const sequence = (...scripted: readonly (() => Effect.Effect<ProviderEvidenceCase>)[]) => {
  let index = 0;
  return handoffDouble(() => {
    const answer = scripted[Math.min(index, scripted.length - 1)] ?? answers.accepted;
    index += 1;
    return answer();
  });
};

describe('Technical Retry of the same Message Intent (#1403)', () => {
  it.live(
    '[S01 AC-01 AC-05 AC-06 R-01 R-04] when Core delivers the message again, a PROVEN temporary non-acceptance continues the SAME intent as a new attempt: same recipient, endpoint, language and revision, a fresh Current gate',
    () =>
      Effect.gen(function* provenTemporary() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = sequence(answers.rateLimited, answers.accepted);
        const { intentId, requestId } = yield* decideOne(world);
        const before = yield* intentRowOf(world, intentId);
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        const queriesAfterFirst = world.privacy.queries.length;
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(2);
        const [first, second] = handoff.calls;
        // the retry is the SAME message: the same intent, tenant, original endpoint, language and pinned template revision
        expect(second).toMatchObject({
          intentId,
          language: first?.language,
          purpose: first?.purpose,
          recipientRef: first?.recipientRef,
          template: first?.template,
          tenantId: world.tenantId,
        });
        expect(Redacted.value(second?.endpoint.value ?? Redacted.make(''))).toBe(ORIGINAL_ADDRESS);
        expect(second?.attemptId).not.toBe(first?.attemptId);
        // a new attempt under the same intent, linked to the proven refusal; the first attempt is untouched
        const attempts = yield* attemptsOf(world, intentId);
        expect(attempts.map(({ attemptNumber, state }) => `${String(attemptNumber)}:${state}`)).toEqual([
          '1:REJECTED',
          '2:ACCEPTED',
        ]);
        expect(yield* retryLinksOf(world, intentId)).toMatchObject([
          { attemptId: attempts[1]?.attemptId, basisKind: 'PRIOR_REJECTED', previousAttemptId: attempts[0]?.attemptId },
        ]);
        expect(yield* intentRowOf(world, intentId)).toEqual(before);
        // [R-06] a stale ALLOWED is never reused: the Current owners were asked AGAIN for the retry, about the ORIGINAL contact
        expect(world.privacy.queries.length).toBeGreaterThan(queriesAfterFirst);
        expect(
          world.recipientAuthority.queries.every(
            ({ contact }) => contact.contactRef.resourceId === 'contact-customer-1',
          ),
        ).toBe(true);
        // the history shows both attempts and the final truth: accepted, no failure, the retry link
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('PROVIDER_ACCEPTED');
        expect(record.links.retries).toMatchObject([{ basisKind: 'PRIOR_REJECTED', reasonCode: 'PRIOR_NOT_ACCEPTED' }]);
        // an accepted submission is never repeated, however often the message is delivered again
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_FINISHED');
        expect(handoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S03 AC-07 R-13 R-14] without an approved recovery rule automatic action halts and records the reason; a Core redrive is not a send approval',
    () =>
      Effect.gen(function* noRule() {
        const world = yield* setup();
        const handoff = sequence(answers.rateLimited, answers.accepted);
        const { intentId, requestId } = yield* decideOne(world);
        yield* stepWith(world, handoff, intentId);
        // Core redelivers the same message (its own technical redrive): every delivery is only an evaluation
        for (let delivery = 0; delivery < 4; delivery += 1) {
          expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HALTED:NO_RECOVERY_RULE');
        }
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        // the unperformed recovery is recorded ONCE with its reason, not once per delivery
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { code: 'NO_RECOVERY_RULE', evaluationSeq: 1, outcome: 'HALTED', proven: false },
        ]);
        const { feed } = yield* historyOf(world, requestId);
        expect(feed.messages).toMatchObject([{ attention: 'FAILURE', reason: 'NO_RECOVERY_RULE', status: 'FAILED' }]);
        expect(feed.sourceImpact).toBe('SOURCE_OWNER_DECIDES');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[R-13 AC-07] the owner's own limit ends automatic recovery: no further attempt, a recorded halt, never an endless loop",
    () =>
      Effect.gen(function* limit() {
        const world = yield* setup({ types: [recoverableType(2)] });
        const handoff = sequence(answers.rateLimited);
        const { intentId } = yield* decideOne(world);
        yield* stepWith(world, handoff, intentId);
        yield* stepWith(world, handoff, intentId);
        expect(handoff.calls).toHaveLength(2);
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HALTED:RECOVERY_LIMIT_REACHED');
        }
        expect(handoff.calls).toHaveLength(2);
        const attempts = yield* attemptsOf(world, intentId);
        expect(attempts.map(({ state }) => state)).toEqual(['REJECTED', 'REJECTED']);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { basisAttemptId: attempts[1]?.attemptId, code: 'RECOVERY_LIMIT_REACHED', outcome: 'HALTED' },
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[S17 R-10 AC-03] a documented PERMANENT refusal stops for good with a concrete reason, whatever the type's rule, and the source learns a proven failure",
    () =>
      Effect.gen(function* permanent() {
        const world = yield* setup({ types: [recoverableType(5)] });
        const handoff = sequence(answers.refused, answers.accepted);
        const { intentId, requestId } = yield* decideOne(world);
        yield* stepWith(world, handoff, intentId);
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PERMANENT_REJECTION', cause: 'PROVIDER_REJECTED', proven: true }],
        });
        // the proven stop is final: a later delivery neither retries nor records another evaluation
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
        expect(handoff.calls).toHaveLength(1);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { code: 'PERMANENT_REJECTION', outcome: 'STOPPED', proven: true },
        ]);
        const record = yield* historyOf(world, requestId);
        expect(record.feed.messages).toMatchObject([
          { attention: 'FAILURE', reason: 'PERMANENT_REJECTION', status: 'FAILED' },
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S04 AC-02 R-05] a timeout, an unavailable provider and any unknown effect never lead to another attempt, whatever the approved rule says',
    () =>
      Effect.gen(function* unknownEffect() {
        for (const answer of [answers.timeout, answers.unavailable]) {
          const world = yield* setup({ types: [recoverableType()] });
          const handoff = sequence(answer, answers.accepted);
          const { intentId, requestId } = yield* decideOne(world);
          yield* stepWith(world, handoff, intentId);
          for (let delivery = 0; delivery < 3; delivery += 1) {
            expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
          }
          expect(handoff.calls).toHaveLength(1);
          expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
          // the owner is asked nothing and nothing is recorded as a halt: the effect is simply not known yet
          expect(yield* recoveriesOf(world, intentId)).toEqual([]);
          const { feed } = yield* historyOf(world, requestId);
          expect(feed.messages[0]).toMatchObject({ attention: 'UNKNOWN', status: 'INDETERMINATE' });
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S02 AC-01] a message still waiting for its FIRST handoff continues as the original intent after an unproven stop: one intent, one attempt, evaluation N+1 appended',
    () =>
      Effect.gen(function* restartContinuation() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const { intentId, requestId } = yield* decideOne(world);
        world.privacy.answers.set('customer-1', privacyIndeterminate);
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED' });
        // Core delivers the message again while the owner still cannot answer: the evaluation is appended, never edited
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED' });
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(1);
        expect(
          (yield* stopsOf(world, intentId)).map(
            ({ evaluationSeq, proven }) => `${String(evaluationSeq)}:${String(proven)}`,
          ),
        ).toEqual(['1:false', '2:false']);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* retryLinksOf(world, intentId)).toEqual([]);
        // the superseded stops stay in the history but no longer hold the message
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('PROVIDER_ACCEPTED');
        expect(record.history.entries.filter(({ kind }) => kind === 'HANDOFF_STOPPED')).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'a PROVEN stop is final: a later delivery appends no evaluation and sends nothing, even if the owner now allows it',
    () =>
      Effect.gen(function* provenFinal() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const { intentId } = yield* decideOne(world);
        world.privacy.answers.set('customer-1', privacyIndeterminate);
        yield* stepWith(world, handoff, intentId);
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED' });
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
        expect(
          (yield* stopsOf(world, intentId)).map(
            ({ evaluationSeq, proven }) => `${String(evaluationSeq)}:${String(proven)}`,
          ),
        ).toEqual(['1:false', '2:true']);
        expect(handoff.calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('what triggers a Technical Retry (#1403 review)', () => {
  it.live(
    '[AC-01 R-13] a provable, recoverable refusal ends the step with a retry due, which asks CORE to redeliver; every other end is final for the delivery',
    () =>
      Effect.gen(function* trigger() {
        const world = yield* setup({ types: [recoverableType(2)] });
        const handoff = sequence(answers.rateLimited);
        const { intentId } = yield* decideOne(world);
        const first = yield* stepWith(world, handoff, intentId);
        expect(first).toMatchObject({ followUp: 'RETRY_DUE', kind: 'HANDED_OFF' });
        const redelivery = yield* Effect.exit(requireRedeliveryWhenRetryDue(first));
        expect(Exit.isFailure(redelivery)).toBe(true);
        expect(JSON.stringify(redelivery)).toContain('NonAcceptanceRetryDue');
        // Core redelivers: the second delivery is the evaluation that begins the next attempt; the owner's limit (2) is then reached
        const second = yield* stepWith(world, handoff, intentId);
        expect(second).toMatchObject({ followUp: 'NONE', kind: 'HANDED_OFF' });
        expect(Exit.isSuccess(yield* Effect.exit(requireRedeliveryWhenRetryDue(second)))).toBe(true);
        expect(handoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-07 R-05] no retry is due after an acceptance, an unknown effect, a permanent refusal, no approved rule or a deployment that made no request',
    () =>
      Effect.gen(function* notDue() {
        const cases: readonly [string, Parameters<typeof setup>[0], () => Effect.Effect<ProviderEvidenceCase>][] = [
          ['accepted', { types: [recoverableType()] }, answers.accepted],
          ['timeout', { types: [recoverableType()] }, answers.timeout],
          ['unavailable', { types: [recoverableType()] }, answers.unavailable],
          ['permanent', { types: [recoverableType()] }, answers.refused],
          ['no rule', {}, answers.rateLimited],
          [
            'no request',
            { types: [recoverableType()] },
            () => Effect.succeed({ kind: 'UNAVAILABLE', reason: 'configuration' } as const),
          ],
        ];
        for (const [, options, answer] of cases) {
          const world = yield* setup(options);
          const { intentId } = yield* decideOne(world);
          const processing = yield* stepWith(world, handoffDouble(answer), intentId);
          expect(processing).toMatchObject({ followUp: 'NONE', kind: 'HANDED_OFF' });
          expect(Exit.isSuccess(yield* Effect.exit(requireRedeliveryWhenRetryDue(processing)))).toBe(true);
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('Current gates during recovery (#1403 R-06 AC-03)', () => {
  const refusedOnce = Effect.fn('RetryTest.refusedOnce')(function* refused(types = [recoverableType()]) {
    const world = yield* setup({ types });
    const handoff = sequence(answers.rateLimited, answers.accepted);
    const { intentId, requestId } = yield* decideOne(world);
    yield* stepWith(world, handoff, intentId);
    return { handoff, intentId, requestId, world };
  });

  it.live(
    '[S12 AC-03] Privacy NOT_ALLOWED before the next attempt stops it with the proven reason, finally; nothing is handed off',
    () =>
      Effect.gen(function* privacyNotAllowedDuringRecovery() {
        const { handoff, intentId, requestId, world } = yield* refusedOnce();
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_NOT_ALLOWED', proven: true }],
        });
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
        expect(handoff.calls).toHaveLength(1);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { code: 'PRIVACY_NOT_ALLOWED', outcome: 'STOPPED', proven: true },
        ]);
        expect((yield* historyOf(world, requestId)).feed.messages[0]).toMatchObject({
          attention: 'FAILURE',
          reason: 'PRIVACY_NOT_ALLOWED',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S13 AC-03] Privacy INDETERMINATE is neither a prohibition nor a permission: nothing is handed off, the stop proves nothing, and the next Current evaluation supersedes it',
    () =>
      Effect.gen(function* privacyIndeterminateDuringRecovery() {
        const { handoff, intentId, requestId, world } = yield* refusedOnce();
        world.privacy.answers.set('customer-1', privacyIndeterminate);
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_INDETERMINATE', proven: false }],
        });
        expect(handoff.calls).toHaveLength(1);
        // not a final failure: the source is told it must be re-evaluated
        expect((yield* historyOf(world, requestId)).feed.messages[0]).toMatchObject({
          attention: 'NEEDS_REEVALUATION',
          reason: 'PRIVACY_INDETERMINATE',
        });
        // the owner answers again: the same intent continues as a new attempt, the earlier evaluation stays
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(2);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([{ outcome: 'STOPPED', proven: false }]);
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['REJECTED', 'ACCEPTED']);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review] the same unproven recovery stop is recorded ONCE per attempt and reason, like a halt: a redelivery cannot flood the history',
    () =>
      Effect.gen(function* dedupedStop() {
        const { handoff, intentId, world } = yield* refusedOnce();
        world.privacy.answers.set('customer-1', privacyIndeterminate);
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED' });
        }
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { evaluationSeq: 1, outcome: 'STOPPED', proven: false },
        ]);
        // a DIFFERENT fact is the next evaluation: the proven prohibition is appended and final
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED' });
        expect(
          (yield* recoveriesOf(world, intentId)).map(
            ({ evaluationSeq, proven }) => `${String(evaluationSeq)}:${String(proven)}`,
          ),
        ).toEqual(['1:false', '2:true']);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S10 AC-03] an ended ORIGINAL endpoint stops the retry; the message is never redirected to a Current contact',
    () =>
      Effect.gen(function* endpointEnded() {
        const { handoff, intentId, world } = yield* refusedOnce();
        world.recipientAuthority.answers.set('contact-customer-1', unusable('ORIGINAL_ENDPOINT_UNUSABLE'));
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'CHANNEL_UNUSABLE', cause: 'ORIGINAL_ENDPOINT_UNUSABLE', proven: true }],
        });
        expect(handoff.calls).toHaveLength(1);
        expect(
          world.recipientAuthority.queries.every(
            ({ contact }) => contact.contactRef.resourceId === 'contact-customer-1',
          ),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[S14 S15 R-08 AC-03] a revoked invitation, an expired token and a consumed OTP are source facts: the old proof is never sent, a new one is only the source owner's",
    () =>
      Effect.gen(function* sourceLifecycle() {
        for (const state of [
          'fixture.state.invitation-revoked',
          'fixture.state.token-expired',
          'fixture.state.otp-consumed',
        ]) {
          const { handoff, intentId, requestId, world } = yield* refusedOnce();
          world.source.state.state = state;
          expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
            kind: 'STOPPED',
            reasons: [{ category: 'SOURCE_STALE', cause: 'SOURCE_STATE_INELIGIBLE', proven: true }],
          });
          expect(handoff.calls).toHaveLength(1);
          // the source owner moved on itself: the source is told so, and Communications changes none of its business state
          const { feed } = yield* historyOf(world, requestId);
          expect(feed.messages[0]).toMatchObject({ attention: 'FAILURE', reason: 'SOURCE_STALE' });
          expect(feed.sourceImpact).toBe('SOURCE_OWNER_DECIDES');
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-10 AC-03] a source owner that cannot be asked is a missing authority, not a proven stop: re-evaluated, never guessed',
    () =>
      Effect.gen(function* missingAuthority() {
        const { handoff, intentId, requestId, world } = yield* refusedOnce();
        world.source.state.available = false;
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'SOURCE_AUTHORITY_UNAVAILABLE', proven: false }],
        });
        expect((yield* historyOf(world, requestId)).feed.messages[0]).toMatchObject({
          attention: 'NEEDS_REEVALUATION',
        });
        world.source.state.available = true;
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[R-10] a retired purpose (a deactivated type) stops the retry with that reason', () =>
    Effect.gen(function* retiredPurpose() {
      const { handoff, intentId, world } = yield* refusedOnce();
      const retired = fixtureType({
        recovery: { kind: 'RETRY_ON_PROVEN_NON_ACCEPTANCE', maxAttempts: 3 },
        status: 'DEACTIVATED',
      });
      expect(yield* stepWith(world, handoff, intentId, [retired])).toMatchObject({
        kind: 'STOPPED',
        reasons: [{ category: 'TYPE_UNAVAILABLE', cause: 'TYPE_DEACTIVATED', proven: true }],
      });
      expect(handoff.calls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[R-07 AC-06] an unsafe pinned template revision is never bypassed and never upgraded by a retry', () =>
    Effect.gen(function* unsafeRevision() {
      const { handoff, intentId, world } = yield* refusedOnce();
      const [stored] = yield* intentRowOf(world, intentId);
      yield* world.database.withPorts(world.tenantId, (templates) =>
        invalidateRevisionAsUnsafe(
          templates,
          { reason: 'Fictional unsafe wording', revisionId: stored?.templateRevisionId ?? '' },
          actorWith('00000000-0000-4000-8000-0000000000a5'),
        ),
      );
      expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
        kind: 'STOPPED',
        reasons: [{ category: 'TEMPLATE_PIN', cause: 'pinned_template_revision_invalidated_unsafe' }],
      });
      expect(handoff.calls).toHaveLength(1);
      expect(yield* intentRowOf(world, intentId)).toEqual([stored]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[Final GOLD] tightening the Tenant mode to B respects the block before a still-stoppable retry, without swapping the pinned language or revision',
    () =>
      Effect.gen(function* tightening() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = sequence(answers.rateLimited, answers.accepted);
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'A', actorWith('00000000-0000-4000-8000-0000000000a4')),
        );
        yield* Ref.set(world.language.ref, { kind: 'trusted', language: 'en' });
        const { intentId } = yield* decideOne(world);
        const [stored] = yield* intentRowOf(world, intentId);
        expect(stored).toMatchObject({ language: 'en', tenantMode: 'A' });
        yield* stepWith(world, handoff, intentId);
        const czech = yield* world.database.withPorts(world.tenantId, (templates) =>
          resolveTemplatePin(templates, { ...templateBase, language: 'cs' }),
        );
        yield* world.database.withPorts(world.tenantId, (templates) =>
          deactivateRevision(
            templates,
            { reason: 'Fictional retirement', revisionId: czech.revisionId },
            actorWith('00000000-0000-4000-8000-0000000000a6'),
          ),
        );
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'B', actorWith('00000000-0000-4000-8000-0000000000a7')),
        );
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'LANGUAGE_GATE', cause: 'czech_revision_required_by_mode_b' }],
        });
        expect(handoff.calls).toHaveLength(1);
        // the mode change created no request, no intent and no resend: the pinned decision is exactly as it was
        expect(yield* intentRowOf(world, intentId)).toEqual([stored]);
        expect(yield* world.read((tx) => tx.select().from(communicationRequests))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('Two workers racing a retry (#1403)', () => {
  it.live('[AC-08 S10] make at most ONE further external attempt, with one link and one attempt row', () =>
    Effect.gen(function* racingRetry() {
      const world = yield* setup({ types: [recoverableType()] });
      let call = 0;
      const handoff = handoffDouble(() => {
        call += 1;
        return call === 1 ? answers.rateLimited() : Effect.yieldNow.pipe(Effect.andThen(answers.accepted));
      });
      const { intentId } = yield* decideOne(world);
      yield* stepWith(world, handoff, intentId);
      const outcomes = yield* Effect.all([stepWith(world, handoff, intentId), stepWith(world, handoff, intentId)], {
        concurrency: 2,
      });
      expect(handoff.calls).toHaveLength(2);
      expect(outcomes.map(({ kind }) => kind).toSorted()).toEqual(['HANDED_OFF', 'SKIPPED']);
      const attempts = yield* attemptsOf(world, intentId);
      expect(attempts.map(({ attemptNumber }) => attemptNumber)).toEqual([1, 2]);
      expect(yield* retryLinksOf(world, intentId)).toHaveLength(1);
      expect(handoff.calls[1]?.attemptId).toBe(yield* attemptIdOf(intentId, 2));
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[R-14] a crash after the retry's provider call leaves the new attempt PREPARED: redelivery reconciles and never resends",
    () =>
      Effect.gen(function* crashDuringRetry() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = sequence(answers.rateLimited, answers.accepted);
        const { intentId } = yield* decideOne(world);
        yield* stepWith(world, handoff, intentId);
        yield* crashAfterProviderCall(world, handoff, intentId);
        expect(handoff.calls).toHaveLength(2);
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['REJECTED', 'PREPARED']);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect(handoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
