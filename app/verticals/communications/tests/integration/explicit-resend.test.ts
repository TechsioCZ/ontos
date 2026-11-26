import { DateTime, Effect, Exit } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import {
  communicationDecisions,
  communicationRequests,
  deliveryAttempts,
  intentResendLinks,
  messageIntents,
} from '../../src/database/schema.ts';
import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import { fixtureType, fixtureTypeNamed } from '../unit/support/catalog-fixtures.ts';
import { privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { decideOne, historyOf, intentHistoryOf, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { actorWith, makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  answers,
  intentRows,
  reconcileOnly,
  resendLinksOf,
  resendableType,
  stepWith,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/**
 * [#1403 Explicit Resend] A NEW source-owner request that names the ORIGINAL intent, decided through the same public intake as
 * any request, on native PostgreSQL as the runtime role. The Messaging Adapter is a labelled double. Nothing here is delivery.
 */
const RECIPIENTS = ['customer-1', 'customer-2'] as const;

const resendRequest = (
  world: World,
  original: typeof MessageIntentIdSchema.Type,
  options: {
    readonly occurrenceId: string;
    readonly profileId?: string;
    readonly purpose?: string;
    readonly reason?: string;
    readonly recipients?: readonly string[];
    readonly sourceModule?: string;
  },
) =>
  communicationRequest({
    bindings: (options.recipients ?? ['customer-1']).map((id) => originalRecipient(id)),
    occurrenceId: options.occurrenceId,
    profileId: options.profileId,
    purpose: options.purpose ?? 'fixture.single',
    resendOf: { originalIntentId: original, reason: options.reason ?? 'RECIPIENT_NOT_RECEIVED' },
    sourceModule: options.sourceModule ?? 'fixture.source',
    tenantId: world.tenantId,
  });

const submitResend = (
  world: World,
  original: typeof MessageIntentIdSchema.Type,
  options: Parameters<typeof resendRequest>[2],
  invocationId = '00000000-0000-4000-8000-0000000000a9',
) =>
  world.runner.submit(
    world.tenantId,
    resendRequest(world, original, options),
    invocationId,
    options.sourceModule ?? 'fixture.source',
  );

/** An accepted original: decided, handed off and answered. */
const acceptedOriginal = Effect.fn('ResendTest.acceptedOriginal')(function* original(world: World) {
  const { intentId, requestId } = yield* decideOne(world);
  const handoff = handoffDouble();
  yield* stepWith(world, handoff, intentId);
  return { handoff, intentId, requestId };
});

const snapshotOf = (world: World) =>
  Effect.all(
    [
      world.read((tx) => tx.select().from(communicationRequests)),
      world.read((tx) => tx.select().from(communicationDecisions)),
      world.read((tx) => tx.select().from(messageIntents)),
      world.read((tx) => tx.select().from(deliveryAttempts)),
    ],
    { concurrency: 1 },
  );

/** The intents a decided request produced; none for a NO_MESSAGE decision. */
const intentsOf = (run: Effect.Success<ReturnType<typeof submitResend>>) => {
  const { decision } = decided(run);
  return decision.kind === 'MESSAGE_INTENTS' ? decision.intents : [];
};

/** The one intent an approved resend decided, or a defect of the test. */
const onlyIntent = Effect.fn('ResendTest.onlyIntent')(function* only(
  run: Effect.Success<ReturnType<typeof submitResend>>,
) {
  const [intent, ...rest] = intentsOf(run);
  if (intent === undefined || rest.length > 0) {
    return yield* Effect.die('the approved resend must decide exactly one intent');
  }
  return intent;
});

const noMessageReasonOf = (run: Effect.Success<ReturnType<typeof submitResend>>) => {
  const result = decided(run);
  return result.decision.kind === 'NO_MESSAGE' ? result.decision.reason : undefined;
};

describe('Explicit Resend is a new, owner-authorized communication (#1403)', () => {
  it.live(
    '[S07 AC-04 AC-05 R-02 R-09] an approved type resends as a NEW request, decision and intent, linked both ways with the closed reason; the original is not touched',
    () =>
      Effect.gen(function* approvedResend() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        const before = yield* snapshotOf(world);
        const run = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-2' });
        const result = decided(run);
        expect(result.replayed).toBe(false);
        expect(result.decision.kind).toBe('MESSAGE_INTENTS');
        const resend = yield* onlyIntent(run);
        expect(resend.status).toBe('PENDING_HANDOFF');
        expect(resend.intentId).not.toBe(original.intentId);
        // the new intent is queued exactly like any other: its own self-outbox message
        expect(run.outbox).toHaveLength(1);
        // the original request, decision, intent and attempt are exactly as they were: nothing is rewritten
        const after = yield* snapshotOf(world);
        for (const [index, rows] of before.entries()) {
          for (const row of rows) {
            expect(after[index]).toContainEqual(row);
          }
        }
        expect((yield* intentRows(world)).length).toBe(2);
        // linked both ways, with the closed business reason
        expect(yield* resendLinksOf(world)).toMatchObject([
          {
            originalIntentId: original.intentId,
            reasonCode: 'RECIPIENT_NOT_RECEIVED',
            resendIntentId: resend.intentId,
          },
        ]);
        const originalRecord = yield* intentHistoryOf(world, original.requestId);
        expect(originalRecord.links.resentAs).toEqual([
          { intentId: resend.intentId, reasonCode: 'RECIPIENT_NOT_RECEIVED' },
        ]);
        expect(originalRecord.history.summary.status).toBe('PROVIDER_ACCEPTED');
        const resendRecord = yield* intentHistoryOf(world, CommunicationRequestIdSchema.make(result.requestId));
        expect(resendRecord.links.resendOf).toEqual({
          intentId: original.intentId,
          reasonCode: 'RECIPIENT_NOT_RECEIVED',
        });
        // the resend is a new message with its own attempts: a Technical Retry of the original would not be one
        const handoff = handoffDouble();
        expect((yield* stepWith(world, handoff, resend.intentId)).kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(1);
        expect((yield* intentHistoryOf(world, original.requestId)).facts.attempts).toHaveLength(1);
        expect(resendRecord.facts.attempts).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S08 AC-04 AC-10 R-03 R-12] a type the source owner did not approve has NO resend: nothing is created, whoever asks, and no tenant switch changes that',
    () =>
      Effect.gen(function* unapproved() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [fixtureType()] });
        const original = yield* acceptedOriginal(world);
        const before = yield* snapshotOf(world);
        const run = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-2' });
        expect(noMessageReasonOf(run)).toBe('RESEND_NOT_APPROVED');
        expect(run.outbox).toEqual([]);
        expect(yield* resendLinksOf(world)).toEqual([]);
        expect(yield* intentRows(world)).toHaveLength(1);
        // the refusal is a stored decision with a closed reason: the source learns it through the ordinary outcome feed
        const { feed } = yield* historyOf(world, CommunicationRequestIdSchema.make(decided(run).requestId));
        expect(feed.noMessageReason).toBe('RESEND_NOT_APPROVED');
        expect(feed.messages).toEqual([]);
        const after = yield* snapshotOf(world);
        expect(after[2]).toEqual(before[2]);
        expect(after[3]).toEqual(before[3]);
        // the only way in is the source owner's own workload: a person, an operator or any other module is refused at the seam
        expect(submitCommunicationRequestAction.descriptor.accessWorkload?.workloads).toEqual([
          'communications.core.request-source',
        ]);
        const impostor = yield* Effect.exit(
          world.runner.submit(
            world.tenantId,
            resendRequest(world, original.intentId, { occurrenceId: 'fixture-occurrence-4' }),
            '00000000-0000-4000-8000-0000000000b9',
            'fixture.other-module',
          ),
        );
        expect(Exit.isFailure(impostor)).toBe(true);
        expect(JSON.stringify(impostor)).toContain('CommunicationRequestSourceMismatch');
        expect(yield* resendLinksOf(world)).toEqual([]);
        expect(yield* intentRows(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S09 R-11 AC-08] the same owner occurrence arriving twice at once is ONE new intent; two DIFFERENT occurrences are two decisions',
    () =>
      Effect.gen(function* duplicates() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        const options = { occurrenceId: 'fixture-occurrence-2' };
        const runs = yield* Effect.all(
          [
            submitResend(world, original.intentId, options, '00000000-0000-4000-8000-0000000000c1'),
            submitResend(world, original.intentId, options, '00000000-0000-4000-8000-0000000000c2'),
          ],
          { concurrency: 2 },
        );
        const results = runs.map(decided);
        expect(results.map(({ replayed }) => Number(replayed)).toSorted((left, right) => left - right)).toEqual([0, 1]);
        expect(new Set(results.map(({ requestId }) => requestId)).size).toBe(1);
        expect(yield* intentRows(world)).toHaveLength(2);
        expect(yield* resendLinksOf(world)).toHaveLength(1);
        // a repeated or parallel call changes nothing and queues nothing a second time
        expect(runs.flatMap(({ outbox }) => outbox)).toHaveLength(1);

        // two DIFFERENT authorized occurrences are two business decisions, each with its own intent and link
        const second = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-3' });
        const third = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-4' });
        expect(decided(second).replayed).toBe(false);
        expect(decided(third).replayed).toBe(false);
        expect(yield* intentRows(world)).toHaveLength(4);
        const links = yield* resendLinksOf(world);
        expect(links).toHaveLength(3);
        expect(new Set(links.map(({ originalIntentId }) => originalIntentId))).toEqual(new Set([original.intentId]));
        expect(new Set(links.map(({ resendIntentId }) => resendIntentId)).size).toBe(3);

        // the same occurrence with ANOTHER meaning (another reason) is a conflict: recorded, nothing else changes
        const conflicting = yield* submitResend(world, original.intentId, {
          occurrenceId: 'fixture-occurrence-2',
          reason: 'PRIOR_DELIVERY_FAILED',
        });
        expect(conflicting.result.outcome).toBe('CONFLICT');
        expect(yield* resendLinksOf(world)).toHaveLength(3);
        expect((yield* resendLinksOf(world)).every(({ reasonCode }) => reasonCode === 'RECIPIENT_NOT_RECEIVED')).toBe(
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S11 R-02] a resend for ANOTHER original address is judged from its own new binding and Current gates; the old intent is neither extended nor rewritten',
    () =>
      Effect.gen(function* newRecipient() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        const [originalBefore] = yield* intentRows(world);
        const queriesBefore = world.recipientAuthority.queries.length;
        const run = yield* submitResend(world, original.intentId, {
          occurrenceId: 'fixture-occurrence-2',
          recipients: ['customer-2'],
        });
        expect(intentsOf(run)).toMatchObject([
          { recipientRef: { resourceId: 'customer-2' }, status: 'PENDING_HANDOFF' },
        ]);
        // the new recipient was asked about through ITS OWN original contact, and only that one
        const asked = world.recipientAuthority.queries
          .slice(queriesBefore)
          .map(({ contact }) => contact.contactRef.resourceId);
        expect(new Set(asked)).toEqual(new Set(['contact-customer-2']));
        const rows = yield* intentRows(world);
        expect(rows.find(({ intentId }) => intentId === original.intentId)).toEqual(originalBefore);
        expect(rows).toHaveLength(2);
        expect(yield* resendLinksOf(world)).toMatchObject([{ originalIntentId: original.intentId }]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-06] the resend meets every Current gate like any new message: a Privacy prohibition suppresses it, and the original stays as it was',
    () =>
      Effect.gen(function* privacyOnResend() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        const run = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-2' });
        expect(intentsOf(run).map(({ status }) => status)).toEqual(['SUPPRESSED']);
        expect(run.outbox).toEqual([]);
        expect((yield* intentHistoryOf(world, original.requestId)).history.summary.status).toBe('PROVIDER_ACCEPTED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-03] an unknown original, the original of another source owner and an original of another type are all refused, alike and without a message',
    () =>
      Effect.gen(function* refusals() {
        const other = fixtureTypeNamed('other', { resend: 'SOURCE_APPROVED', sourceOwner: 'fixture.other-source' });
        const sibling = fixtureTypeNamed('sibling', { resend: 'SOURCE_APPROVED' });
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType(), other, sibling] });
        const original = yield* acceptedOriginal(world);
        const unknown = MessageIntentIdSchema.make('99999999-9999-4999-8999-999999999999');
        expect(noMessageReasonOf(yield* submitResend(world, unknown, { occurrenceId: 'fixture-occurrence-2' }))).toBe(
          'RESEND_ORIGINAL_NOT_FOUND',
        );
        // another source owner cannot resend this source's message, and learns nothing but "not found"
        expect(
          noMessageReasonOf(
            yield* submitResend(world, original.intentId, {
              occurrenceId: 'fixture-occurrence-3',
              purpose: 'fixture.other',
              sourceModule: 'fixture.other-source',
            }),
          ),
        ).toBe('RESEND_ORIGINAL_NOT_FOUND');
        expect(
          noMessageReasonOf(
            yield* submitResend(world, original.intentId, {
              occurrenceId: 'fixture-occurrence-4',
              purpose: 'fixture.sibling',
            }),
          ),
        ).toBe('RESEND_ORIGINAL_TYPE_MISMATCH');
        expect(yield* resendLinksOf(world)).toEqual([]);
        expect(yield* intentRows(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S04 R-05] a resend is never created while it is unknown whether the original left; once a reconciliation proves what happened, a NEW request is admitted',
    () =>
      Effect.gen(function* unknownOriginal() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const { intentId, requestId } = yield* decideOne(world);
        const handoff = handoffDouble(answers.timeout);
        yield* stepWith(world, handoff, intentId);
        expect(noMessageReasonOf(yield* submitResend(world, intentId, { occurrenceId: 'fixture-occurrence-2' }))).toBe(
          'RESEND_ORIGINAL_EFFECT_UNKNOWN',
        );
        expect(yield* resendLinksOf(world)).toEqual([]);
        // the refusal is that occurrence's own decision: it is not retried silently, a new owner decision is a new occurrence
        const [attempt] = (yield* intentHistoryOf(world, requestId)).facts.attempts;
        const target = targetOf(world, intentId, attempt?.attemptId ?? '');
        yield* reconcileOnly(world, intentId, [
          step22Double.acceptanceProven(target, { key: 'r-1', observedAt: yield* DateTime.now }),
        ]);
        const admitted = yield* submitResend(world, intentId, { occurrenceId: 'fixture-occurrence-3' });
        expect(decided(admitted).decision.kind).toBe('MESSAGE_INTENTS');
        expect(yield* resendLinksOf(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review R-03] an original requested in ANOTHER scope is refused exactly like an unknown one: no oracle, no message, no link',
    () =>
      Effect.gen(function* crossLegalEntity() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        const unknown = MessageIntentIdSchema.make('99999999-9999-4999-8999-999999999999');
        // the runner's trusted principal is Tenant-wide, so the scope dimension a Postgres test can vary is the profile; the Legal Entity
        // dimension of the same scope key is proven by the unit and the public-boundary tests (the key covers both)
        const otherProfile = 'profile-other';
        const crossed = yield* submitResend(world, original.intentId, {
          occurrenceId: 'fixture-occurrence-2',
          profileId: otherProfile,
        });
        const missing = yield* submitResend(world, unknown, {
          occurrenceId: 'fixture-occurrence-3',
          profileId: otherProfile,
        });
        expect(noMessageReasonOf(crossed)).toBe('RESEND_ORIGINAL_NOT_FOUND');
        expect(noMessageReasonOf(missing)).toBe('RESEND_ORIGINAL_NOT_FOUND');
        expect(yield* resendLinksOf(world)).toEqual([]);
        expect(yield* intentRows(world)).toHaveLength(1);
        // the SAME scope as the original is admitted: the scope, not the request, was the obstacle
        const sameScope = yield* submitResend(world, original.intentId, { occurrenceId: 'fixture-occurrence-4' });
        expect(decided(sameScope).decision.kind).toBe('MESSAGE_INTENTS');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review R-05] an original that is still waiting for its first outcome is not resent: both could be delivered; a provable refusal can be',
    () =>
      Effect.gen(function* pendingOriginal() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const { intentId } = yield* decideOne(world);
        // no attempt yet: the ordinary step can still deliver it
        expect(noMessageReasonOf(yield* submitResend(world, intentId, { occurrenceId: 'fixture-occurrence-2' }))).toBe(
          'RESEND_ORIGINAL_EFFECT_UNKNOWN',
        );
        expect(yield* resendLinksOf(world)).toEqual([]);
        // the original is provably refused and nothing recovers it automatically (no approved rule): the source owner may resend
        yield* stepWith(world, handoffDouble(answers.refused), intentId);
        const admitted = yield* submitResend(world, intentId, { occurrenceId: 'fixture-occurrence-3' });
        expect(decided(admitted).decision.kind).toBe('MESSAGE_INTENTS');
        expect(yield* resendLinksOf(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[Final GOLD] a language-mode change is NOT a resend request: it creates no request, intent or link, and rewrites no pin',
    () =>
      Effect.gen(function* modeChange() {
        const world = yield* setup({ recipients: RECIPIENTS, types: [resendableType()] });
        const original = yield* acceptedOriginal(world);
        const before = yield* snapshotOf(world);
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'A', actorWith('00000000-0000-4000-8000-0000000000a4')),
        );
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'B', actorWith('00000000-0000-4000-8000-0000000000a7')),
        );
        expect(yield* snapshotOf(world)).toEqual(before);
        expect(yield* resendLinksOf(world)).toEqual([]);
        expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toEqual([]);
        expect((yield* intentHistoryOf(world, original.requestId)).links.resentAs).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
