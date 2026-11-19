import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import type { StoredJson } from '../../src/database/schema.ts';
import {
  deliveryAttempts,
  intentResendLinks,
  messageIntents,
  providerObservations,
} from '../../src/database/schema.ts';
import { canAttemptAfterUnknownEffect, unknownEffectBlock } from '../../src/domain/history/unknown-effect.ts';
import type { FreshEligibility } from '../../src/domain/history/unknown-effect.ts';
import { LinkReasonCodeSchema } from '../../src/domain/history/vocabulary.ts';
import { linkRetryAttempt } from '../../src/history/provider-observations.ts';
import { workerFinishAttemptRoutine } from '../../src/persistence/communications-routines.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import {
  FIXTURE_APPROVER_ROLE,
  fixtureType,
  noMessageType,
  nRecipientPolicyType,
} from '../unit/support/catalog-fixtures.ts';
import { privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { binding, ORIGINAL_ADDRESS } from '../unit/support/recipient-fixtures.ts';
import {
  decideOne,
  historyOf,
  ingest,
  intentHistoryOf,
  intentIdAt,
  minutesFromNow,
  step,
  targetOf,
} from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { baseIdentity, seedLanguages } from '../support/language-fixtures.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { step22Double } from '../support/step22-observation-double.ts';

/**
 * [#1402] The truthful message history on native PostgreSQL, as the runtime role and through the REAL scoped routines. The
 * Messaging Adapter and the step 22 evidence are labelled test doubles (`handoffDouble`, `step22Double`): they prove how
 * Communications READS an answer, never that a real provider answers so. Nothing here is delivery or provider evidence, and
 * every DELIVERED path is conditional on step 22 proving a real delivery capability.
 */

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

const indeterminate = () => Effect.succeed({ kind: 'INDETERMINATE', reason: 'timeout' } as const);
const notAttempted = () => Effect.succeed({ kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' } as const);

const attemptsOf = (world: World, intentId: string) =>
  world
    .read((tx) => tx.select().from(deliveryAttempts).where(eq(deliveryAttempts.intentId, intentId)))
    .pipe(Effect.map((rows) => rows.toSorted((left, right) => left.attemptNumber - right.attemptNumber)));

/** The attempt at `index` (oldest first) of an intent, or a defect of the test. */
const attemptAt = Effect.fn('HistoryTest.attemptAt')(function* attempt(world: World, intentId: string, index = 0) {
  const rows = yield* attemptsOf(world, intentId);
  return yield* Option.match(Option.fromNullishOr(rows[index]), {
    onNone: () => Effect.die(`the intent has no attempt at ${String(index)}`),
    onSome: (row) => Effect.succeed(row),
  });
});

const observationsOf = (world: World) => world.read((tx) => tx.select().from(providerObservations));

const ProviderRefEvidenceSchema = Schema.Struct({ providerRef: Schema.String });
const providerRefOf = (evidence: StoredJson | null) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ProviderRefEvidenceSchema)(evidence))?.providerRef;

type Answer = Parameters<typeof handoffDouble>[0];

/** One intent whose submission has just been answered: the world, the intent and its (first) attempt. */
const submitted = Effect.fn('HistoryTest.submitted')(function* submit(
  answer?: Answer,
  options: Parameters<typeof setup>[0] = {},
) {
  const world = yield* setup(options);
  const handoff = handoffDouble(answer);
  const { intentId, requestId } = yield* decideOne(world);
  yield* step(world, handoff, intentId);
  const attempt = yield* attemptAt(world, intentId);
  return { attempt, attemptId: attempt.attemptId, handoff, intentId, requestId, world };
});

type PostgresFailureInput = Parameters<typeof findPostgresFailure>[0];
const sqlStateOf = (failure: PostgresFailureInput) =>
  Option.match(findPostgresFailure(failure), { onNone: () => 'none', onSome: ({ code }) => code });

const adminClient = loadDatabaseConnectionPair().pipe(
  Effect.flatMap(({ admin }) => PgClient.makeClient({ url: Redacted.make(admin.connectionString) })),
);

const eligibleAt = (evaluatedAt: DateTime.Utc, eligible = true): Option.Option<FreshEligibility> =>
  Option.some({ eligible, evaluatedAt });

const HISTORY_TABLES = [
  'communication_requests',
  'communication_request_conflicts',
  'communication_decisions',
  'message_intents',
  'delivery_attempts',
  'intent_handoff_stops',
  'provider_observations',
  'attempt_retry_links',
  'intent_resend_links',
];

/** Content that must be in NO stored fact of the history: an address, a link, markup, a secret. */
const FORBIDDEN_CONTENT = [
  new RegExp(ORIGINAL_ADDRESS.replaceAll('.', String.raw`\.`), 'u'),
  /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]/u,
  /https?:\/\//u,
  /<\/?[a-z][^>]*>/iu,
  /\b(?:otp|password|passwd|secret|bearer|claim[-_]?url|reset[-_]?token|invitation[-_]?proof)\b/iu,
];

/** Every row of every history table of one Tenant as JSON text, read as the table owner. */
const storedRowsOf = Effect.fn('HistoryTest.storedRowsOf')(function* storedRows(tenantId: string) {
  const admin = yield* adminClient;
  const dump = yield* admin.withTransaction(
    Effect.gen(function* dumpRows() {
      yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [tenantId]);
      return yield* Effect.forEach(
        HISTORY_TABLES,
        (table) =>
          admin.unsafe<{ readonly row: string }>(
            `select row_to_json(t)::text as row from communications.${table} t where t.tenant_id = $1`,
            [tenantId],
          ),
        { concurrency: 1 },
      );
    }),
  );
  return dump.flat().map(({ row }) => row);
});

/** Columns of the history tables whose name says they could hold an address, a token, a payload or markup. */
const historyColumnsThatCouldHoldContent = Effect.fn('HistoryTest.historyColumns')(function* columnsOfHistory() {
  const admin = yield* adminClient;
  const columns = yield* admin.unsafe<{ readonly column_name: string }>(
    `select column_name::text from information_schema.columns where table_schema = 'communications' and table_name = any($1::text[])`,
    [['provider_observations', 'attempt_retry_links', 'intent_resend_links']],
  );
  return columns
    .map(({ column_name: name }) => name)
    .filter((name) => /address|email|token|secret|otp|payload|body|html|url|password/u.test(name));
});

describe('Truthful message history on native PostgreSQL (#1402)', () => {
  it.live(
    '[AC-01 AC-02 AC-08 S01 S02 S03] one history per request: no-message, suppressed and prepared stay distinct, with safe fields only',
    () =>
      Effect.gen(function* oneHistoryPerRequest() {
        const world = yield* setup({ recipients: ['customer-1', 'p-denied'], types: [fixtureType(), noMessageType] });
        world.privacy.answers.set('p-denied', privacyNotAllowed());
        const prepared = yield* decideOne(world, 'customer-1', 'o-prepared');
        const suppressed = yield* decideOne(world, 'p-denied', 'o-suppressed');
        const quiet = decided(
          yield* world.runner.submit(
            world.tenantId,
            communicationRequest({
              bindings: [originalRecipient('customer-1')],
              occurrenceId: 'o-quiet',
              purpose: noMessageType.purpose,
              tenantId: world.tenantId,
            }),
          ),
        );
        // the catalog decided that no message exists: a NO_MESSAGE decision, no intent and never an attempt
        const quietHistory = yield* historyOf(world, quiet.requestId);
        expect(quietHistory.intents).toEqual([]);
        expect(quietHistory.noMessageReason).toBe('APPROVED_NO_MESSAGE');
        expect(quietHistory.feed).toMatchObject({
          noMessageReason: 'APPROVED_NO_MESSAGE',
          requiredOutcome: 'NOT_REQUIRED',
        });
        expect(yield* world.read((tx) => tx.select().from(deliveryAttempts))).toEqual([]);

        // a concrete message stopped by Privacy: SUPPRESSED with the safe original reason, not a provider failure
        const suppressedRecord = yield* intentHistoryOf(world, suppressed.requestId);
        expect(suppressedRecord).toMatchObject({
          decisionReason: 'PRIVACY_NOT_ALLOWED',
          history: { summary: { providerAccepted: false, status: 'SUPPRESSED' } },
        });

        // a prepared message no provider was asked about: PREPARED, never accepted
        expect((yield* intentHistoryOf(world, prepared.requestId)).history.summary.status).toBe('PREPARED');

        yield* step(world, handoffDouble(), prepared.intentId);
        const after = yield* historyOf(world, prepared.requestId);
        const record = yield* intentHistoryOf(world, prepared.requestId);
        expect(record.history.summary).toMatchObject({
          deliveryProven: false,
          providerAccepted: true,
          status: 'PROVIDER_ACCEPTED',
        });
        // the safe record: exact source occurrence and purpose, trusted scope, original recipient in safe form, language, template
        expect(after.request).toMatchObject({
          occurrenceId: 'o-prepared',
          occurrenceRevision: 1,
          purpose: 'fixture.single',
          scope: { tenantId: world.tenantId },
          sourceModule: 'fixture.source',
        });
        expect(record).toMatchObject({
          language: { language: 'cs', mode: 'B' },
          recipient: { ref: { resourceId: 'customer-1' }, role: 'original-recipient' },
          template: { messageType: 'fixture.single-message', revisionNumber: 1 },
          type: { typeId: 'fixture.single-message', typeRevision: 1 },
        });
        expect(record.recipient.endpointMask).toBeDefined();
        expect(record.recipient.endpointMask).not.toBe(ORIGINAL_ADDRESS);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-02 S09] a restart recomputes the very same history: nothing is duplicated and no meaning is added', () =>
    Effect.gen(function* restart() {
      const { handoff, intentId, requestId, world } = yield* submitted();
      const first = yield* historyOf(world, requestId);
      // Core redelivers the message after a restart: the step finds the finished attempt and nothing changes
      yield* step(world, handoff, intentId);
      const second = yield* historyOf(world, requestId);
      expect(second).toEqual(first);
      const record = yield* intentHistoryOf(world, requestId);
      expect(record.history.entries.map(({ kind }) => kind)).toEqual([
        'INTENT_PREPARED',
        'ATTEMPT_PREPARED',
        'SUBMISSION_ANSWERED',
      ]);
      expect(handoff.calls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02] 0..N attempts: an attempt that submitted nothing never blocks the next, and both stay in the history',
    () =>
      Effect.gen(function* manyAttempts() {
        const world = yield* setup();
        const { intentId, requestId } = yield* decideOne(world);
        yield* step(world, handoffDouble(notAttempted), intentId);
        expect((yield* intentHistoryOf(world, requestId)).history.summary.status).toBe('PREPARED');
        yield* step(world, handoffDouble(), intentId);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('PROVIDER_ACCEPTED');
        expect(record.facts.attempts.map(({ attemptNumber, state }) => [attemptNumber, state])).toEqual([
          [1, 'NOT_ATTEMPTED'],
          [2, 'ACCEPTED'],
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-03 AC-10 S04 S05 S06] provider acceptance is never delivery; DELIVERED needs a step 22 delivery observation',
    () =>
      Effect.gen(function* acceptanceIsNotDelivery() {
        const { attempt, attemptId, intentId, requestId, world } = yield* submitted();
        const accepted = yield* intentHistoryOf(world, requestId);
        // the provider evidences nothing more than the submission: the correct history has NO delivery claim
        expect(accepted.history.summary).toMatchObject({ deliveryProven: false, status: 'PROVIDER_ACCEPTED' });
        // CONDITIONAL on a real step 22 delivery proof capability: only this observation can make it DELIVERED
        const answer = yield* ingest(
          world,
          step22Double.delivered(targetOf(world, intentId, attemptId), {
            key: 'evt-delivered-1',
            observedAt: yield* minutesFromNow(5),
            providerRef: providerRefOf(attempt.evidence),
          }),
        );
        expect(answer).toBe('RECORDED');
        const delivered = yield* intentHistoryOf(world, requestId);
        expect(delivered.history.summary).toMatchObject({
          deliveryProven: true,
          providerAccepted: true,
          status: 'DELIVERED',
        });
        // the earlier acceptance is still there, and the attempt itself was never edited
        expect(delivered.history.entries.map(({ status }) => status)).toEqual([
          'PREPARED',
          'PROVIDER_SUBMITTED',
          'PROVIDER_ACCEPTED',
          'DELIVERED',
        ]);
        expect(yield* attemptAt(world, intentId)).toMatchObject({ state: 'ACCEPTED' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-04 S07] a timeout is INDETERMINATE: reconciliation is required, nothing is sent again, no failure is claimed',
    () =>
      Effect.gen(function* timeout() {
        const { handoff, intentId, requestId, world } = yield* submitted(indeterminate);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ providerAccepted: false, status: 'INDETERMINATE' });
        expect(record.history.entries.at(-1)).toMatchObject({
          reasonCodes: ['timeout'],
          technical: 'ACCEPTANCE_INDETERMINATE',
        });
        // a redelivery and a blind retry make no second external attempt
        yield* step(world, handoff, intentId);
        expect(handoff.calls).toHaveLength(1);
        // and the guard of the retry lane says no, whatever Current eligibility is offered
        const now = yield* minutesFromNow(5);
        expect(unknownEffectBlock(record.facts, eligibleAt(now))).toEqual(Option.some('RECONCILIATION_REQUIRED'));
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-04 S08] a reconciliation that proved NON-acceptance keeps the indeterminate fact and adds the proof; a send needs fresh eligibility',
    () =>
      Effect.gen(function* reconciledNotAccepted() {
        const { attemptId, handoff, intentId, requestId, world } = yield* submitted(indeterminate);
        const answer = yield* ingest(
          world,
          step22Double.nonAcceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'reconciliation-1',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        expect(answer).toBe('RECORDED');
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ providerAccepted: false, status: 'FAILED' });
        expect(record.history.entries.map(({ status }) => status)).toEqual([
          'PREPARED',
          'PROVIDER_SUBMITTED',
          'INDETERMINATE',
          'FAILED',
        ]);
        // the original fact is untouched, and the observation caused no send
        expect(yield* attemptAt(world, intentId)).toMatchObject({ state: 'INDETERMINATE' });
        expect(handoff.calls).toHaveLength(1);
        const before = DateTime.subtract(yield* DateTime.now, { minutes: 1 });
        const after = yield* minutesFromNow(10);
        // evidence exists, but an eligibility evaluated BEFORE it is a retained answer; only a Current one allows a further send
        expect(canAttemptAfterUnknownEffect(record.facts, eligibleAt(before))).toBe(false);
        expect(canAttemptAfterUnknownEffect(record.facts, Option.none())).toBe(false);
        expect(canAttemptAfterUnknownEffect(record.facts, eligibleAt(after, false))).toBe(false);
        expect(canAttemptAfterUnknownEffect(record.facts, eligibleAt(after))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-04 S09] a reconciliation that proved acceptance keeps both observations and never allows a second send',
    () =>
      Effect.gen(function* reconciledAccepted() {
        const { attemptId, handoff, intentId, requestId, world } = yield* submitted(indeterminate);
        yield* ingest(
          world,
          step22Double.acceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'reconciliation-2',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ providerAccepted: true, status: 'PROVIDER_ACCEPTED' });
        expect(record.history.entries.map(({ status }) => status)).toEqual([
          'PREPARED',
          'PROVIDER_SUBMITTED',
          'INDETERMINATE',
          'PROVIDER_ACCEPTED',
        ]);
        expect(handoff.calls).toHaveLength(1);
        expect(unknownEffectBlock(record.facts, eligibleAt(yield* minutesFromNow(10)))).toEqual(
          Option.some('ACCEPTANCE_ALREADY_PROVEN'),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-05 S10] a bounce after acceptance is a NEW observation: the acceptance stays, the attempt is never edited',
    () =>
      Effect.gen(function* lateBounce() {
        const { attempt, attemptId, handoff, intentId, requestId, world } = yield* submitted();
        const answer = yield* ingest(
          world,
          step22Double.bounced(targetOf(world, intentId, attemptId), {
            key: 'evt-bounce-1',
            observedAt: yield* minutesFromNow(30),
            providerRef: providerRefOf(attempt.evidence),
          }),
        );
        expect(answer).toBe('RECORDED');
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({
          deliveryProven: false,
          providerAccepted: true,
          status: 'FAILED',
        });
        expect(record.history.entries.map(({ status }) => status)).toEqual([
          'PREPARED',
          'PROVIDER_SUBMITTED',
          'PROVIDER_ACCEPTED',
          'FAILED',
        ]);
        expect(yield* attemptAt(world, intentId)).toMatchObject({ evidence: attempt.evidence, state: 'ACCEPTED' });
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S11] a duplicate or repeated callback is one observation: no second row, no second effect; the same identity with other content conflicts',
    () =>
      Effect.gen(function* duplicateCallback() {
        const { attemptId, handoff, intentId, world } = yield* submitted(indeterminate);
        const target = targetOf(world, intentId, attemptId);
        const input = step22Double.acceptanceProven(target, { key: 'evt-dup-1', observedAt: yield* minutesFromNow(1) });
        expect(yield* ingest(world, input)).toBe('RECORDED');
        expect(yield* ingest(world, input)).toBe('DUPLICATE');
        const concurrent = yield* Effect.all([ingest(world, input), ingest(world, input)], { concurrency: 2 });
        expect(concurrent).toEqual(['DUPLICATE', 'DUPLICATE']);
        // the same event identity arriving with another claim is a conflict, and the first one stays
        const conflicting = step22Double.nonAcceptanceProven(target, {
          key: 'evt-dup-1',
          observedAt: yield* minutesFromNow(2),
        });
        expect(yield* ingest(world, conflicting)).toBe('CONFLICT');
        const stored = yield* observationsOf(world);
        expect(stored).toHaveLength(1);
        expect(stored).toMatchObject([{ kind: 'ACCEPTANCE_PROVEN' }]);
        // nothing was sent, created or finished by any of it
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S12 AC-06] a callback of another company is never bound and reveals nothing: the answer equals that of an unknown intent',
    () =>
      Effect.gen(function* otherTenant() {
        const a = yield* submitted(indeterminate);
        const b = yield* submitted(indeterminate);
        const foreign = targetOf(b.world, b.intentId, b.attemptId);
        const observedAt = yield* minutesFromNow(1);
        // Tenant B's intent and attempt, presented in Tenant A's verified scope, claiming either Tenant
        const claimingB = yield* ingest(a.world, step22Double.acceptanceProven(foreign, { key: 'x-1', observedAt }));
        const claimingA = yield* ingest(
          a.world,
          step22Double.acceptanceProven({ ...foreign, tenantId: a.world.tenantId }, { key: 'x-2', observedAt }),
        );
        const unknown = yield* ingest(
          a.world,
          step22Double.acceptanceProven(
            {
              attemptId: DeliveryAttemptIdSchema.make('00000000-0000-4000-8000-0000000000aa'),
              intentId: MessageIntentIdSchema.make('00000000-0000-4000-8000-0000000000bb'),
              tenantId: a.world.tenantId,
            },
            { key: 'x-3', observedAt },
          ),
        );
        expect([claimingB, claimingA, unknown]).toEqual(['UNBOUND', 'UNBOUND', 'UNBOUND']);
        // B's own scope claiming A's Tenant is refused the same way, and nothing was written for either Tenant
        const reversed = yield* ingest(
          b.world,
          step22Double.acceptanceProven({ ...foreign, tenantId: a.world.tenantId }, { key: 'x-4', observedAt }),
        );
        expect(reversed).toBe('UNBOUND');
        expect(yield* observationsOf(a.world)).toEqual([]);
        expect(yield* observationsOf(b.world)).toEqual([]);
        expect((yield* intentHistoryOf(b.world, b.requestId)).history.summary.status).toBe('INDETERMINATE');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-06 S13] two profiles with one e-mail address: an outcome is bound to its own intent and attempt, never to the sibling',
    () =>
      Effect.gen(function* twoProfiles() {
        const world = yield* setup({ recipients: ['profile-1', 'profile-2'] });
        const handoff = handoffDouble();
        const first = yield* decideOne(world, 'profile-1', 'o-profile-1');
        const second = yield* decideOne(world, 'profile-2', 'o-profile-2');
        yield* step(world, handoff, first.intentId);
        yield* step(world, handoff, second.intentId);
        // both profiles really share ONE e-mail address
        expect(new Set(handoff.calls.map((call) => Redacted.value(call.endpoint.value))).size).toBe(1);
        const firstAttempt = yield* attemptAt(world, first.intentId);
        const secondAttempt = yield* attemptAt(world, second.intentId);
        const observedAt = yield* minutesFromNow(5);
        const delivered = step22Double.delivered(targetOf(world, first.intentId, firstAttempt.attemptId), {
          key: 'evt-p1',
          observedAt,
        });
        expect(yield* ingest(world, delivered)).toBe('RECORDED');
        // the sibling profile's history is untouched
        expect((yield* intentHistoryOf(world, second.requestId)).history.summary.status).toBe('PROVIDER_ACCEPTED');
        expect((yield* intentHistoryOf(world, first.requestId)).history.summary.status).toBe('DELIVERED');
        // an observation naming one profile's intent with the other's attempt belongs to neither
        const mixed = step22Double.delivered(targetOf(world, first.intentId, secondAttempt.attemptId), {
          key: 'evt-mix',
          observedAt,
        });
        expect(yield* ingest(world, mixed)).toBe('UNBOUND');
        // and the sibling's provider reference can never be used for this profile's attempt
        const borrowed = step22Double.delivered(targetOf(world, second.intentId, secondAttempt.attemptId), {
          key: 'evt-ref',
          observedAt,
          providerRef: providerRefOf(firstAttempt.evidence),
        });
        expect(yield* ingest(world, borrowed)).toBe('PROVIDER_MISMATCH');
        expect(yield* observationsOf(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S14 H-07] an out-of-order callback keeps the explicit timeline: both facts are kept, the late one is flagged, the head stays truthful',
    () =>
      Effect.gen(function* outOfOrder() {
        const { attemptId, handoff, intentId, requestId, world } = yield* submitted(indeterminate);
        const target = targetOf(world, intentId, attemptId);
        // the bounce (30 minutes in) arrives first; the acceptance it presupposes (10 minutes in) arrives afterwards
        yield* ingest(
          world,
          step22Double.bounced(target, { key: 'evt-bounce', observedAt: yield* minutesFromNow(30) }),
        );
        yield* ingest(
          world,
          step22Double.acceptanceProven(
            target,
            { key: 'evt-accept', observedAt: yield* minutesFromNow(10) },
            'PROVIDER_EVENT',
          ),
        );
        const record = yield* intentHistoryOf(world, requestId);
        const observed = record.history.entries.filter(({ kind }) => kind === 'PROVIDER_OBSERVED');
        expect(observed.map(({ observationKind, outOfOrder: late }) => [observationKind, late])).toEqual([
          ['ACCEPTANCE_PROVEN', true],
          ['DELIVERY_FAILED', false],
        ]);
        expect(record.history.summary).toMatchObject({ providerAccepted: true, status: 'FAILED' });
        expect(yield* attemptAt(world, intentId)).toMatchObject({ state: 'INDETERMINATE' });
        expect(handoff.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S12] an outcome never moves to another provider identity, and an attempt that submitted nothing has nothing to observe',
    () =>
      Effect.gen(function* providerIdentity() {
        const accepted = yield* submitted();
        const observedAt = yield* minutesFromNow(1);
        const acceptedTarget = targetOf(accepted.world, accepted.intentId, accepted.attemptId);
        const otherProvider = step22Double.delivered(acceptedTarget, {
          key: 'p-1',
          observedAt,
          providerKey: 'other-provider',
        });
        expect(yield* ingest(accepted.world, otherProvider)).toBe('PROVIDER_MISMATCH');
        const otherReference = step22Double.delivered(acceptedTarget, {
          key: 'p-2',
          observedAt,
          providerRef: 'another-reference',
        });
        expect(yield* ingest(accepted.world, otherReference)).toBe('PROVIDER_MISMATCH');
        // an attempt without a provider identity of its own is bound by the FIRST observation, and only that provider may follow
        const unknown = yield* submitted(indeterminate);
        const unknownTarget = targetOf(unknown.world, unknown.intentId, unknown.attemptId);
        const first = step22Double.acceptanceProven(unknownTarget, {
          key: 'q-1',
          observedAt,
          providerKey: 'provider-a',
        });
        const second = step22Double.bounced(unknownTarget, { key: 'q-2', observedAt, providerKey: 'provider-b' });
        expect(yield* ingest(unknown.world, first)).toBe('RECORDED');
        expect(yield* ingest(unknown.world, second)).toBe('PROVIDER_MISMATCH');
        expect(yield* observationsOf(accepted.world)).toEqual([]);
        expect(yield* observationsOf(unknown.world)).toHaveLength(1);
        // nothing was submitted by an attempt that no adapter was asked about
        const none = yield* submitted(notAttempted);
        const nothing = step22Double.delivered(targetOf(none.world, none.intentId, none.attemptId), {
          key: 'r-1',
          observedAt,
        });
        expect(yield* ingest(none.world, nothing)).toBe('NOT_SUBMITTED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 S15] Technical Retry is a NEW attempt of the SAME intent: same pins, a structural link, no retry logic',
    () =>
      Effect.gen(function* technicalRetry() {
        const world = yield* setup();
        const { intentId, requestId } = yield* decideOne(world);
        const intentBefore = yield* world.read((tx) => tx.select().from(messageIntents));
        yield* step(world, handoffDouble(notAttempted), intentId);
        yield* step(world, handoffDouble(), intentId);
        const first = yield* attemptAt(world, intentId, 0);
        const second = yield* attemptAt(world, intentId, 1);
        const link = (reasonCode: string, previous: string) =>
          world.database.inTenant(world.tenantId, (tx) =>
            linkRetryAttempt(tx, {
              attemptId: DeliveryAttemptIdSchema.make(second.attemptId),
              basis: { kind: 'PRIOR_NOT_ATTEMPTED' },
              intentId,
              previousAttemptId: DeliveryAttemptIdSchema.make(previous),
              reasonCode: LinkReasonCodeSchema.make(reasonCode),
            }),
          );
        expect(yield* link('PRIOR_NOT_SUBMITTED', first.attemptId)).toBe('LINKED');
        expect(yield* link('PRIOR_NOT_SUBMITTED', first.attemptId)).toBe('EXISTS');
        expect(yield* link('SOMETHING_ELSE', second.attemptId)).toBe('CONFLICT');
        // both attempts belong to the one intent, and the immutable intent (recipient, language, template pin) never changed
        expect([first.intentId, second.intentId]).toEqual([intentId, intentId]);
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toEqual(intentBefore);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.links.retries).toEqual([
          {
            attemptId: second.attemptId,
            basisKind: 'PRIOR_NOT_ATTEMPTED',
            previousAttemptId: first.attemptId,
            reasonCode: 'PRIOR_NOT_SUBMITTED',
          },
        ]);
        expect(record.links.resentAs).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 S15 H-08] a retry after an unknown effect can only be linked to a recorded proof of non-acceptance of THAT attempt',
    () =>
      Effect.gen(function* retryAfterReconciliation() {
        const { attemptId, intentId, requestId, world } = yield* submitted(indeterminate);
        const admin = yield* adminClient;
        // the recovery lane (d21-10) will begin the next attempt itself; here a second PREPARED attempt stands in for it
        const secondId = yield* nextId;
        yield* admin.withTransaction(
          Effect.gen(function* insertSecond() {
            yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
            yield* admin.unsafe(
              `insert into communications.delivery_attempts (attempt_id, tenant_id, intent_id, attempt_number, state, prepared_at)
             values ($1, $2, $3, 2, 'PREPARED', now())`,
              [secondId, world.tenantId, intentId],
            );
          }),
        );
        const link = (basis: Parameters<typeof linkRetryAttempt>[1]['basis']) =>
          world.database.inTenant(world.tenantId, (tx) =>
            linkRetryAttempt(tx, {
              attemptId: DeliveryAttemptIdSchema.make(secondId),
              basis,
              intentId,
              previousAttemptId: DeliveryAttemptIdSchema.make(attemptId),
              reasonCode: LinkReasonCodeSchema.make('RECONCILED_NOT_ACCEPTED'),
            }),
          );
        // an unknown effect has neither a NOT_ATTEMPTED basis nor an unrecorded proof
        expect(yield* link({ kind: 'PRIOR_NOT_ATTEMPTED' })).toBe('BASIS_MISSING');
        const unrecorded = { kind: 'RECONCILED_NON_ACCEPTANCE', observationId: yield* nextId } as const;
        expect(yield* link(unrecorded)).toBe('BASIS_MISSING');
        yield* ingest(
          world,
          step22Double.nonAcceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'reconciliation-3',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const [proof] = yield* observationsOf(world);
        const recorded = { kind: 'RECONCILED_NON_ACCEPTANCE', observationId: proof?.observationId ?? '' } as const;
        expect(yield* link(recorded)).toBe('LINKED');
        // the new attempt is accepted: the earlier unknown answer and its proof stay, and the intent now reads as accepted
        yield* world.database.inTenant(world.tenantId, (tx) =>
          tx.invoke(workerFinishAttemptRoutine, [
            secondId,
            'ACCEPTED',
            { kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'fixture-ref-2' },
          ]),
        );
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('PROVIDER_ACCEPTED');
        expect(record.facts.attempts.map(({ attemptNumber, state }) => [attemptNumber, state])).toEqual([
          [1, 'INDETERMINATE'],
          [2, 'ACCEPTED'],
        ]);
        expect(record.links.retries).toMatchObject([
          { basisKind: 'RECONCILED_NON_ACCEPTANCE', previousAttemptId: attemptId },
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 S16] Explicit Resend is a NEW intent of a NEW request, linked both ways with a safe reason, and keeps its own facts',
    () =>
      Effect.gen(function* explicitResend() {
        const world = yield* setup();
        const original = yield* decideOne(world, 'customer-1', 'o-original');
        yield* step(world, handoffDouble(), original.intentId);
        const attempt = yield* attemptAt(world, original.intentId);
        yield* ingest(
          world,
          step22Double.bounced(targetOf(world, original.intentId, attempt.attemptId), {
            key: 'evt-bounce-resend',
            observedAt: yield* minutesFromNow(5),
            providerRef: providerRefOf(attempt.evidence),
          }),
        );
        // the source owner approved a resend: a new committed request, hence a new intent with its own identity
        const resend = yield* decideOne(world, 'customer-1', 'o-resend');
        expect(resend.intentId).not.toBe(original.intentId);
        const linkedAt = DateTime.toDateUtc(yield* DateTime.now);
        const insertLink = (originalIntentId: string, resendIntentId: string, reasonCode: string) =>
          world.database.inTenant(world.tenantId, (tx) =>
            tx
              .insert(intentResendLinks)
              .values({ linkedAt, originalIntentId, reasonCode, resendIntentId, tenantId: world.tenantId }),
          );
        yield* insertLink(original.intentId, resend.intentId, 'SOURCE_APPROVED_RESEND');
        const originalRecord = yield* intentHistoryOf(world, original.requestId);
        const resendRecord = yield* intentHistoryOf(world, resend.requestId);
        expect(originalRecord.links.resentAs).toEqual([
          { intentId: resend.intentId, reasonCode: 'SOURCE_APPROVED_RESEND' },
        ]);
        expect(resendRecord.links.resendOf).toEqual({
          intentId: original.intentId,
          reasonCode: 'SOURCE_APPROVED_RESEND',
        });
        // no implicit "resend succeeded": the original keeps its failure, the resend is only prepared, and has no attempt
        expect(originalRecord.history.summary.status).toBe('FAILED');
        expect(resendRecord.history.summary.status).toBe('PREPARED');
        expect(yield* attemptsOf(world, resend.intentId)).toEqual([]);
        // a resend names exactly one original, and an intent is never its own ancestor
        const second = yield* Effect.exit(insertLink(original.intentId, resend.intentId, 'OTHER_REASON'));
        expect(Exit.isFailure(second)).toBe(true);
        const cycle = yield* Effect.flip(insertLink(resend.intentId, original.intentId, 'LOOP'));
        expect(sqlStateOf(cycle)).toBe('23514');
        // a link is a fact: it can be neither rewritten nor removed
        const rewrite = yield* Effect.exit(
          world.database.inTenant(world.tenantId, (tx) => tx.update(intentResendLinks).set({ reasonCode: 'EDITED' })),
        );
        expect(Exit.isFailure(rewrite)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[AC-09] a resend link needs two distinct intents of the Tenant and can only be written in that Tenant's own scope",
    () =>
      Effect.gen(function* resendGuards() {
        const world = yield* setup();
        const first = yield* decideOne(world, 'customer-1', 'o-guard-1');
        const second = yield* decideOne(world, 'customer-1', 'o-guard-2');
        const linkedAt = DateTime.toDateUtc(yield* DateTime.now);
        const link = (originalIntentId: string, resendIntentId: string, tenantId = world.tenantId) =>
          world.database.inTenant(world.tenantId, (tx) =>
            tx.insert(intentResendLinks).values({
              linkedAt,
              originalIntentId,
              reasonCode: 'SOURCE_APPROVED_RESEND',
              resendIntentId,
              tenantId,
            }),
          );
        expect(sqlStateOf(yield* Effect.flip(link(first.intentId, first.intentId)))).toBe('23514');
        // an intent that does not exist in the Tenant cannot be linked
        expect(sqlStateOf(yield* Effect.flip(link(first.intentId, yield* nextId)))).toBe('23503');
        // another Tenant's scope cannot write a link for this one
        expect(sqlStateOf(yield* Effect.flip(link(first.intentId, second.intentId, yield* nextId)))).toBe('42501');
        yield* link(first.intentId, second.intentId);
        expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-09] two intents of ONE request are siblings, never an original and its resend', () =>
    Effect.gen(function* siblings() {
      const world = yield* setup({
        recipients: ['approver-1', 'approver-2', 'approver-3'],
        types: [nRecipientPolicyType],
      });
      yield* world.database.withPorts(world.tenantId, (templates) =>
        seedLanguages(templates, ['cs'], { ...baseIdentity, messageType: nRecipientPolicyType.typeId }),
      );
      const run = decided(
        yield* world.runner.submit(
          world.tenantId,
          communicationRequest({
            bindings: ['approver-1', 'approver-2', 'approver-3'].map((id) => binding(FIXTURE_APPROVER_ROLE, id)),
            purpose: nRecipientPolicyType.purpose,
            tenantId: world.tenantId,
          }),
        ),
      );
      const intents = run.decision.kind === 'MESSAGE_INTENTS' ? run.decision.intents : [];
      expect(intents).toHaveLength(3);
      const linkedAt = DateTime.toDateUtc(yield* DateTime.now);
      const originalIntentId = yield* intentIdAt(intents, 0);
      const resendIntentId = yield* intentIdAt(intents, 1);
      const failure = yield* Effect.flip(
        world.database.inTenant(world.tenantId, (tx) =>
          tx.insert(intentResendLinks).values({
            linkedAt,
            originalIntentId,
            reasonCode: 'SOURCE_APPROVED_RESEND',
            resendIntentId,
            tenantId: world.tenantId,
          }),
        ),
      );
      expect(sqlStateOf(failure)).toBe('23514');
      expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[append-only H-05] observations and links are facts: not rewritable, not removable, not forgeable, and invisible to another Tenant',
    () =>
      Effect.gen(function* appendOnly() {
        const { attemptId, intentId, world } = yield* submitted(indeterminate);
        yield* ingest(
          world,
          step22Double.acceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'evt-ao-1',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const update = yield* Effect.exit(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.update(providerObservations).set({ kind: 'DELIVERY_PROVEN' }),
          ),
        );
        const removal = yield* Effect.exit(
          world.database.inTenant(world.tenantId, (tx) => tx.delete(providerObservations)),
        );
        const forged = yield* Effect.exit(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.insert(providerObservations).values({
              attemptId,
              evidence: { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_PROVEN' },
              intentId,
              kind: 'DELIVERY_PROVEN',
              observationId: '00000000-0000-4000-8000-0000000000e9',
              observationKey: 'forged-1',
              observedAt: now,
              providerKey: 'fixture-provider',
              recordedAt: now,
              tenantId: world.tenantId,
            }),
          ),
        );
        expect([update, removal, forged].every(Exit.isFailure)).toBe(true);
        // even the owner role cannot rewrite or remove one: a trigger refuses it whatever the privileges
        const admin = yield* adminClient;
        const refused = (statement: string) =>
          Effect.flip(
            admin.withTransaction(
              Effect.gen(function* run() {
                yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
                yield* admin.unsafe(statement);
              }),
            ),
          );
        const adminUpdate = yield* refused(`update communications.provider_observations set kind = 'DELIVERY_PROVEN'`);
        const adminDelete = yield* refused(`delete from communications.provider_observations`);
        expect([sqlStateOf(adminUpdate), sqlStateOf(adminDelete)]).toEqual(['55000', '55000']);
        // Tenant isolation
        const stranger = yield* nextId;
        expect(yield* world.database.inTenant(stranger, (tx) => tx.select().from(providerObservations))).toEqual([]);
        expect(yield* observationsOf(world)).toMatchObject([{ kind: 'ACCEPTANCE_PROVEN' }]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[H-11 H-14 L-13] the safe decision reason and the language mode used survive a later mode change', () =>
    Effect.gen(function* modeSurvives() {
      const world = yield* setup();
      const { requestId } = yield* decideOne(world);
      const before = yield* intentHistoryOf(world, requestId);
      expect(before.language).toMatchObject({ language: 'cs', mode: 'B', policy: { source: 'platform-default' } });
      yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
        setLanguageMode(policies, 'A', actorWith('00000000-0000-4000-8000-0000000000a4')),
      );
      const after = yield* intentHistoryOf(world, requestId);
      expect(after.language).toEqual(before.language);
      expect(after.history).toEqual(before.history);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[H-13 AC-07] the source outcome of a REQUIRED message: unknown after a timeout, failed once non-acceptance is proven, never a commit or a rollback',
    () =>
      Effect.gen(function* requiredOutcome() {
        const { attemptId, intentId, requestId, world } = yield* submitted(indeterminate, {
          types: [fixtureType({ requiredness: 'REQUIRED' })],
        });
        const unknown = (yield* historyOf(world, requestId)).feed;
        expect(unknown).toMatchObject({
          messages: [{ attention: 'UNKNOWN', status: 'INDETERMINATE' }],
          requiredOutcome: 'UNKNOWN',
          sourceImpact: 'SOURCE_OWNER_DECIDES',
        });
        yield* ingest(
          world,
          step22Double.nonAcceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'reconciliation-4',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const failed = (yield* historyOf(world, requestId)).feed;
        expect(failed).toMatchObject({
          messages: [{ attention: 'FAILURE', status: 'FAILED' }],
          requiredOutcome: 'FAILED',
        });
        // the feed holds references and closed codes only: nothing of the recipient's address, no token, no link
        expect(JSON.stringify(failed)).not.toContain(ORIGINAL_ADDRESS);
        expect(JSON.stringify(failed)).not.toMatch(/https?:|@/u);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[H-12 AC-08] after a full run no history row, column or record holds an address, a link, markup or a secret',
    () =>
      Effect.gen(function* redaction() {
        const world = yield* setup({ recipients: ['customer-1', 'customer-2'] });
        const one = yield* decideOne(world, 'customer-1', 'o-red-1');
        const two = yield* decideOne(world, 'customer-2', 'o-red-2');
        yield* step(world, handoffDouble(), one.intentId);
        yield* step(world, handoffDouble(indeterminate), two.intentId);
        const accepted = yield* attemptAt(world, one.intentId);
        const unknown = yield* attemptAt(world, two.intentId);
        yield* ingest(
          world,
          step22Double.bounced(targetOf(world, one.intentId, accepted.attemptId), {
            key: 'evt-red-1',
            observedAt: yield* minutesFromNow(3),
            providerRef: providerRefOf(accepted.evidence),
          }),
        );
        yield* ingest(
          world,
          step22Double.nonAcceptanceProven(targetOf(world, two.intentId, unknown.attemptId), {
            key: 'reconciliation-red',
            observedAt: yield* minutesFromNow(4),
          }),
        );
        const stored = yield* storedRowsOf(world.tenantId);
        expect(stored.length).toBeGreaterThan(5);
        const records = JSON.stringify([
          yield* historyOf(world, one.requestId),
          yield* historyOf(world, two.requestId),
        ]);
        for (const text of [...stored, records]) {
          for (const pattern of FORBIDDEN_CONTENT) {
            expect(text).not.toMatch(pattern);
          }
        }
        // and the schema has no column that could hold one
        expect(yield* historyColumnsThatCouldHoldContent()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
