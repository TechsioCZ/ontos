import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import type { StoredJson } from '../../src/database/schema.ts';
import {
  attemptRetryLinks,
  deliveryAttempts,
  intentResendLinks,
  messageIntents,
  providerObservationConflicts,
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
import { privacyIndeterminate, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
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
const conflictsOf = (world: World) => world.read((tx) => tx.select().from(providerObservationConflicts));

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
  'provider_observation_conflicts',
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
    [['provider_observations', 'provider_observation_conflicts', 'attempt_retry_links', 'intent_resend_links']],
  );
  return columns
    .map(({ column_name: name }) => name)
    .filter((name) => /address|email|token|secret|otp|payload|body|html|url|password/u.test(name));
});

/** The recovery lane (d21-10) will begin the next attempt itself; a second PREPARED attempt stands in for it here. */
const insertPreparedAttempt = Effect.fn('HistoryTest.insertPreparedAttempt')(function* insertAttempt(
  world: World,
  intentId: string,
  attemptNumber = 2,
) {
  const admin = yield* adminClient;
  const attemptId = yield* nextId;
  yield* admin.withTransaction(
    Effect.gen(function* insertSecond() {
      yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
      yield* admin.unsafe(
        `insert into communications.delivery_attempts (attempt_id, tenant_id, intent_id, attempt_number, state, prepared_at)
         values ($1, $2, $3, $4, 'PREPARED', now())`,
        [attemptId, world.tenantId, intentId, attemptNumber],
      );
    }),
  );
  return attemptId;
});

const rejected = () => Effect.succeed({ kind: 'REJECTED', reason: 'provider_rejected' } as const);
const unavailable = () => Effect.succeed({ kind: 'UNAVAILABLE', reason: 'provider_unavailable' } as const);
const unconfigured = () => Effect.succeed({ kind: 'UNAVAILABLE', reason: 'configuration' } as const);

type RetryBasisInput = Parameters<typeof linkRetryAttempt>[1]['basis'];

/** One structural retry link of the world's Tenant, through the real scoped routine. */
const linkRetry = (world: World, intentId: string, previous: string, next: string, basis: RetryBasisInput) =>
  world.database.inTenant(world.tenantId, (tx) =>
    linkRetryAttempt(tx, {
      attemptId: DeliveryAttemptIdSchema.make(next),
      basis,
      intentId: MessageIntentIdSchema.make(intentId),
      previousAttemptId: DeliveryAttemptIdSchema.make(previous),
      reasonCode: LinkReasonCodeSchema.make('PRIOR_NOT_ACCEPTED'),
    }),
  );

/** What the retry guard answers for the intent of a request, with a Current eligibility evaluated after everything recorded. */
const guardAllows = Effect.fn('HistoryTest.guardAllows')(function* allows(
  world: World,
  requestId: Parameters<typeof intentHistoryOf>[1],
) {
  const record = yield* intentHistoryOf(world, requestId);
  return canAttemptAfterUnknownEffect(record.facts, eligibleAt(yield* minutesFromNow(10)));
});

/** One Explicit Resend link of the world's Tenant, written as the runtime role does. */
const insertResendLink = (
  world: World,
  linkedAt: Date,
  originalIntentId: string,
  resendIntentId: string,
  reasonCode: string,
) =>
  world.database.inTenant(world.tenantId, (tx) =>
    tx
      .insert(intentResendLinks)
      .values({ linkedAt, originalIntentId, reasonCode, resendIntentId, tenantId: world.tenantId }),
  );

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
    '[S11] a duplicate or repeated callback is one observation: no second row, no second effect; the same time is part of the content',
    () =>
      Effect.gen(function* duplicateCallback() {
        const { attemptId, handoff, intentId, world } = yield* submitted(indeterminate);
        const target = targetOf(world, intentId, attemptId);
        const input = step22Double.acceptanceProven(target, { key: 'evt-dup-1', observedAt: yield* minutesFromNow(1) });
        expect(yield* ingest(world, input)).toBe('RECORDED');
        expect(yield* ingest(world, input)).toBe('DUPLICATE');
        const concurrent = yield* Effect.all([ingest(world, input), ingest(world, input)], { concurrency: 2 });
        expect(concurrent).toEqual(['DUPLICATE', 'DUPLICATE']);
        expect(yield* observationsOf(world)).toHaveLength(1);
        expect(yield* conflictsOf(world)).toEqual([]);
        // nothing was sent, created or finished by any of it
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S11 H-07 review] the SAME identity with another content (even only another time) is a CONFLICT: the first fact stays, a durable safe trace is kept, and the history needs reconciliation',
    () =>
      Effect.gen(function* conflictingRedelivery() {
        const { attemptId, handoff, intentId, requestId, world } = yield* submitted(indeterminate, {
          types: [fixtureType({ requiredness: 'REQUIRED' })],
        });
        const target = targetOf(world, intentId, attemptId);
        const first = step22Double.acceptanceProven(target, {
          key: 'evt-conf-1',
          observedAt: yield* minutesFromNow(1),
        });
        expect(yield* ingest(world, first)).toBe('RECORDED');
        const [original] = yield* observationsOf(world);
        // the very same event, claimed to have happened at ANOTHER time: this is no duplicate
        const otherTime = step22Double.acceptanceProven(target, {
          key: 'evt-conf-1',
          observedAt: yield* minutesFromNow(9),
        });
        expect(yield* ingest(world, otherTime)).toBe('CONFLICT');
        // another evidence basis and another provider reference under the same identity conflict as well
        const otherBasis = step22Double.acceptanceProven(
          target,
          { key: 'evt-conf-1', observedAt: yield* minutesFromNow(1) },
          'PROVIDER_EVENT',
        );
        expect(yield* ingest(world, otherBasis)).toBe('CONFLICT');
        const otherRef = step22Double.acceptanceProven(target, {
          key: 'evt-conf-1',
          observedAt: yield* minutesFromNow(1),
          providerRef: 'ref-1',
        });
        expect(yield* ingest(world, otherRef)).toBe('CONFLICT');
        // delivering the same conflicting content again, also concurrently, adds no second trace
        const again = yield* Effect.all(
          [ingest(world, otherTime), ingest(world, otherTime), ingest(world, otherBasis)],
          {
            concurrency: 3,
          },
        );
        expect(again).toEqual(['CONFLICT', 'CONFLICT', 'CONFLICT']);
        // the first observation is untouched
        expect(yield* observationsOf(world)).toEqual([original]);
        const traces = yield* conflictsOf(world);
        expect(traces).toHaveLength(3);
        expect(traces).toMatchObject(
          traces.map(() => ({
            attemptId,
            intentId,
            kind: 'ACCEPTANCE_PROVEN',
            observationId: original?.observationId,
            observationKey: 'evt-conf-1',
            providerKey: 'fixture-provider',
            tenantId: world.tenantId,
          })),
        );
        // safe fields only: a fingerprint of the content, never the content
        expect(traces.every(({ contentFingerprint }) => /^[0-9a-f]{64}$/u.test(contentFingerprint))).toBe(true);
        expect(new Set(traces.map(({ contentFingerprint }) => contentFingerprint)).size).toBe(3);
        expect(Object.keys(traces[0] ?? {}).toSorted()).toEqual([
          'attemptId',
          'conflictId',
          'contentFingerprint',
          'intentId',
          'kind',
          'observationId',
          'observationKey',
          'observedAt',
          'providerKey',
          'recordedAt',
          'recordedSeq',
          'tenantId',
        ]);
        // the history keeps the earlier fact AND says it needs reconciliation; it is never an acceptance of the conflict
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({
          needsReconciliation: true,
          providerAccepted: true,
          status: 'PROVIDER_ACCEPTED',
        });
        expect(record.history.entries.filter(({ kind }) => kind === 'PROVIDER_OBSERVED')).toHaveLength(1);
        expect(record.history.entries.filter(({ kind }) => kind === 'OBSERVATION_CONFLICTED')).toHaveLength(3);
        expect((yield* historyOf(world, requestId)).feed).toMatchObject({
          messages: [{ attention: 'NEEDS_RECONCILIATION', status: 'PROVIDER_ACCEPTED' }],
          requiredOutcome: 'UNKNOWN',
        });
        // and nothing may be sent again on the strength of it
        expect(unknownEffectBlock(record.facts, eligibleAt(yield* minutesFromNow(10)))).toEqual(
          Option.some('ACCEPTANCE_ALREADY_PROVEN'),
        );
        // nothing was sent, created or finished by any of it
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S11 H-05 H-07 review] one provider message id may carry an acceptance and a bounce: the same key with ANOTHER evidence kind is a NEW observation, not a conflict',
    () =>
      Effect.gen(function* sameKeyOtherKind() {
        const { attemptId, intentId, requestId, world } = yield* submitted(indeterminate);
        const target = targetOf(world, intentId, attemptId);
        const observedAt = yield* minutesFromNow(1);
        const accepted = step22Double.acceptanceProven(target, { key: 'msg-1', observedAt }, 'PROVIDER_EVENT');
        const bounced = step22Double.bounced(target, { key: 'msg-1', observedAt: yield* minutesFromNow(5) });
        expect(yield* ingest(world, accepted)).toBe('RECORDED');
        expect(yield* ingest(world, bounced)).toBe('RECORDED');
        // each one is a duplicate of itself, and neither one conflicts with the other
        expect(yield* ingest(world, accepted)).toBe('DUPLICATE');
        expect(yield* ingest(world, bounced)).toBe('DUPLICATE');
        const stored = yield* observationsOf(world);
        expect(stored.map(({ kind }) => kind).toSorted()).toEqual(['ACCEPTANCE_PROVEN', 'DELIVERY_FAILED']);
        expect(new Set(stored.map(({ observationId }) => observationId)).size).toBe(2);
        expect(yield* conflictsOf(world)).toEqual([]);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({
          needsReconciliation: false,
          providerAccepted: true,
          status: 'FAILED',
        });
        // a changed content of the BOUNCE under the same key conflicts with the bounce only, and the acceptance stays
        const changedBounce = step22Double.bounced(
          target,
          { key: 'msg-1', observedAt: yield* minutesFromNow(5) },
          'BOUNCED_TRANSIENT',
        );
        expect(yield* ingest(world, changedBounce)).toBe('CONFLICT');
        expect(yield* conflictsOf(world)).toMatchObject([{ kind: 'DELIVERY_FAILED' }]);
        expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
          needsReconciliation: true,
          providerAccepted: true,
          status: 'FAILED',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review] a soft bounce is DELIVERY_DEFERRED, and the owner order (not the provider clock) decides the latest delivery fact',
    () =>
      Effect.gen(function* skewAndSoftBounce() {
        const { attempt, attemptId, intentId, requestId, world } = yield* submitted();
        const target = targetOf(world, intentId, attemptId);
        const providerRef = providerRefOf(attempt.evidence);
        yield* ingest(
          world,
          step22Double.bounced(
            target,
            { key: 'soft-1', observedAt: yield* minutesFromNow(5), providerRef },
            'BOUNCED_TRANSIENT',
          ),
        );
        expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
          deliveryProven: false,
          providerAccepted: true,
          status: 'DELIVERY_DEFERRED',
        });
        // recorded FIRST: a delivery the provider stamps late; recorded SECOND: a permanent bounce it stamps early (skew)
        yield* ingest(
          world,
          step22Double.delivered(target, { key: 'dlv-1', observedAt: yield* minutesFromNow(50), providerRef }),
        );
        yield* ingest(
          world,
          step22Double.bounced(
            target,
            { key: 'hard-1', observedAt: yield* minutesFromNow(6), providerRef },
            'BOUNCED_PERMANENT',
          ),
        );
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ providerAccepted: true, status: 'FAILED' });
        // the entries still list the claimed times, and flag the one recorded after a later claim
        expect(
          record.history.entries
            .filter(({ kind }) => kind === 'PROVIDER_OBSERVED')
            .map(({ observationKind, outOfOrder }) => [observationKind, outOfOrder]),
        ).toEqual([
          ['DELIVERY_FAILED', false],
          ['DELIVERY_FAILED', true],
          ['DELIVERY_PROVEN', false],
        ]);
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
        // the pre-handoff step already recorded the link when it began the second attempt (#1403): the same link is idempotent
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
        const secondId = yield* insertPreparedAttempt(world, intentId);
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
    '[AC-09 S15 H-08 review] a retry link follows the same truth as the guard: after a provider REJECTION and an unconfigured deployment, never after UNAVAILABLE, INDETERMINATE or ACCEPTED without reconciliation',
    () =>
      Effect.gen(function* retryBases() {
        const prepared = yield* submitted(rejected);
        const bases = (world: World, intentId: string, previous: string, second: string) => ({
          not: linkRetry(world, intentId, previous, second, { kind: 'PRIOR_NOT_ATTEMPTED' }),
          rejected: linkRetry(world, intentId, previous, second, { kind: 'PRIOR_REJECTED' }),
        });
        // REJECTED: the provider provably refused it. The guard says nothing is in doubt, and the link agrees
        expect(yield* guardAllows(prepared.world, prepared.requestId)).toBe(true);
        const secondRejected = yield* insertPreparedAttempt(prepared.world, prepared.intentId);
        const afterRejection = bases(prepared.world, prepared.intentId, prepared.attemptId, secondRejected);
        // nothing was "not attempted": a rejection is its own basis
        expect(yield* afterRejection.not).toBe('BASIS_MISSING');
        expect(yield* afterRejection.rejected).toBe('LINKED');
        expect(yield* afterRejection.rejected).toBe('EXISTS');
        expect((yield* intentHistoryOf(prepared.world, prepared.requestId)).links.retries).toMatchObject([
          { attemptId: secondRejected, basisKind: 'PRIOR_REJECTED', previousAttemptId: prepared.attemptId },
        ]);

        // an unconfigured deployment made no request: it reads as NOT_ATTEMPTED and so does its retry basis
        const noRequest = yield* submitted(unconfigured);
        expect(yield* guardAllows(noRequest.world, noRequest.requestId)).toBe(true);
        expect((yield* intentHistoryOf(noRequest.world, noRequest.requestId)).history.summary.status).toBe('PREPARED');
        const secondNoRequest = yield* insertPreparedAttempt(noRequest.world, noRequest.intentId);
        const afterNoRequest = bases(noRequest.world, noRequest.intentId, noRequest.attemptId, secondNoRequest);
        expect(yield* afterNoRequest.rejected).toBe('BASIS_MISSING');
        expect(yield* afterNoRequest.not).toBe('LINKED');
        // and nothing is left to observe
        expect(
          yield* ingest(
            noRequest.world,
            step22Double.acceptanceProven(targetOf(noRequest.world, noRequest.intentId, noRequest.attemptId), {
              key: 'nr-1',
              observedAt: yield* minutesFromNow(1),
            }),
          ),
        ).toBe('NOT_SUBMITTED');

        // an unavailable PROVIDER and an indeterminate answer leave the effect unknown: neither basis exists for either
        for (const answer of [unavailable, indeterminate]) {
          const unknown = yield* submitted(answer);
          expect(yield* guardAllows(unknown.world, unknown.requestId)).toBe(false);
          const secondUnknown = yield* insertPreparedAttempt(unknown.world, unknown.intentId);
          const afterUnknown = bases(unknown.world, unknown.intentId, unknown.attemptId, secondUnknown);
          expect([yield* afterUnknown.not, yield* afterUnknown.rejected]).toEqual(['BASIS_MISSING', 'BASIS_MISSING']);
          expect(yield* unknown.world.read((tx) => tx.select().from(attemptRetryLinks))).toEqual([]);
        }

        // an ACCEPTED attempt has no basis at all, not even a proof of non-acceptance that contradicts it
        const accepted = yield* submitted();
        const secondAccepted = yield* insertPreparedAttempt(accepted.world, accepted.intentId);
        expect(yield* guardAllows(accepted.world, accepted.requestId)).toBe(false);
        yield* ingest(
          accepted.world,
          step22Double.nonAcceptanceProven(targetOf(accepted.world, accepted.intentId, accepted.attemptId), {
            key: 'contra-1',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const [proof] = yield* observationsOf(accepted.world);
        const afterAccepted = bases(accepted.world, accepted.intentId, accepted.attemptId, secondAccepted);
        expect([yield* afterAccepted.not, yield* afterAccepted.rejected]).toEqual(['BASIS_MISSING', 'BASIS_MISSING']);
        expect(
          yield* linkRetry(accepted.world, accepted.intentId, accepted.attemptId, secondAccepted, {
            kind: 'RECONCILED_NON_ACCEPTANCE',
            observationId: proof?.observationId ?? '',
          }),
        ).toBe('BASIS_MISSING');
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
          insertResendLink(world, linkedAt, originalIntentId, resendIntentId, reasonCode);
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
        // a resend names exactly one original (a second link of the same resend is refused by its key)
        const second = yield* Effect.flip(insertLink(original.intentId, resend.intentId, 'SOURCE_APPROVED_RESEND'));
        expect(sqlStateOf(second)).toBe('23505');
        // the reason is from a closed list: free or unknown text is refused
        const unlisted = yield* Effect.flip(insertLink(original.intentId, resend.intentId, 'OTHER_REASON'));
        expect(sqlStateOf(unlisted)).toBe('23514');
        // an intent is never its own ancestor: the original cannot be linked as a resend of its own resend
        const cycle = yield* Effect.flip(insertLink(resend.intentId, original.intentId, 'SOURCE_APPROVED_RESEND'));
        expect(sqlStateOf(cycle)).toBe('23514');
        // a link is a fact: it can be neither rewritten nor removed
        const rewrite = yield* Effect.flip(
          world.database.inTenant(world.tenantId, (tx) => tx.update(intentResendLinks).set({ reasonCode: 'EDITED' })),
        );
        expect(sqlStateOf(rewrite)).toBe('42501');
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
    '[AC-09 review] a resend must be NEWER than its original, of the same Tenant, and two opposite inserts cannot both pass',
    () =>
      Effect.gen(function* resendOrderAndTenant() {
        const world = yield* setup();
        const other = yield* setup();
        const older = yield* decideOne(world, 'customer-1', 'o-order-1');
        const newer = yield* decideOne(world, 'customer-1', 'o-order-2');
        const foreign = yield* decideOne(other, 'customer-1', 'o-order-3');
        const linkedAt = DateTime.toDateUtc(yield* DateTime.now);
        const link = (originalIntentId: string, resendIntentId: string, reasonCode = 'SOURCE_APPROVED_RESEND') =>
          insertResendLink(world, linkedAt, originalIntentId, resendIntentId, reasonCode);
        // an OLDER intent can never be the resend of a newer one
        expect(sqlStateOf(yield* Effect.flip(link(newer.intentId, older.intentId)))).toBe('23514');
        // another Tenant's intent is never found in this Tenant's scope, as original or as resend
        expect(sqlStateOf(yield* Effect.flip(link(older.intentId, foreign.intentId)))).toBe('23503');
        expect(sqlStateOf(yield* Effect.flip(link(foreign.intentId, newer.intentId)))).toBe('23503');
        expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toEqual([]);
        // two opposite inserts at once: exactly one passes, and it is the one that respects the order
        const outcomes = yield* Effect.all(
          [
            Effect.exit(link(older.intentId, newer.intentId)),
            Effect.exit(link(newer.intentId, older.intentId)),
            Effect.exit(link(older.intentId, newer.intentId)),
            Effect.exit(link(newer.intentId, older.intentId)),
          ],
          { concurrency: 4 },
        );
        const failures = outcomes.flatMap((outcome) => (Exit.isFailure(outcome) ? [sqlStateOf(outcome.cause)] : []));
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        expect(failures.toSorted()).toEqual(['23505', '23514', '23514']);
        expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toMatchObject([
          { originalIntentId: older.intentId, resendIntentId: newer.intentId },
        ]);
        // an original may have several resends, and a resend of a resend is a chain, never a loop
        const third = yield* decideOne(world, 'customer-1', 'o-order-4');
        yield* link(newer.intentId, third.intentId);
        expect(sqlStateOf(yield* Effect.flip(link(third.intentId, older.intentId)))).toBe('23514');
        expect(yield* world.read((tx) => tx.select().from(intentResendLinks))).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[H-03 H-13 review] a stop that only could not establish a fact is HELD_UNPROVEN and needs re-evaluation; a proven stop stays SUPPRESSED',
    () =>
      Effect.gen(function* heldUnproven() {
        const held = yield* setup({ types: [fixtureType({ requiredness: 'REQUIRED' })] });
        const { intentId, requestId } = yield* decideOne(held);
        held.privacy.answers.set('customer-1', privacyIndeterminate);
        expect(yield* step(held, handoffDouble(), intentId)).toMatchObject({ kind: 'STOPPED' });
        const record = yield* intentHistoryOf(held, requestId);
        expect(record.history.summary.status).toBe('HELD_UNPROVEN');
        expect(record.history.entries.at(-1)).toMatchObject({
          kind: 'HANDOFF_STOPPED',
          reasonCodes: ['PRIVACY_INDETERMINATE'],
          status: 'HELD_UNPROVEN',
        });
        expect((yield* historyOf(held, requestId)).feed).toMatchObject({
          messages: [{ attention: 'NEEDS_REEVALUATION', status: 'HELD_UNPROVEN' }],
          requiredOutcome: 'NEEDS_REEVALUATION',
        });
        const proven = yield* setup({ types: [fixtureType({ requiredness: 'REQUIRED' })] });
        const provenIntent = yield* decideOne(proven);
        proven.privacy.answers.set('customer-1', privacyNotAllowed());
        yield* step(proven, handoffDouble(), provenIntent.intentId);
        expect((yield* historyOf(proven, provenIntent.requestId)).feed).toMatchObject({
          messages: [{ attention: 'FAILURE', status: 'SUPPRESSED' }],
          requiredOutcome: 'FAILED',
        });
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
        // the runtime role holds no INSERT, UPDATE or DELETE privilege on a fact: the database refuses with its own code
        const update = yield* Effect.flip(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.update(providerObservations).set({ kind: 'DELIVERY_PROVEN' }),
          ),
        );
        const removal = yield* Effect.flip(
          world.database.inTenant(world.tenantId, (tx) => tx.delete(providerObservations)),
        );
        const forged = yield* Effect.flip(
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
        const forgedConflict = yield* Effect.flip(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.insert(providerObservationConflicts).values({
              attemptId,
              conflictId: '00000000-0000-4000-8000-0000000000e7',
              contentFingerprint: '0'.repeat(64),
              intentId,
              kind: 'ACCEPTANCE_PROVEN',
              observationId: '00000000-0000-4000-8000-0000000000e8',
              observationKey: 'forged-2',
              observedAt: now,
              providerKey: 'fixture-provider',
              recordedAt: now,
              tenantId: world.tenantId,
            }),
          ),
        );
        expect([update, removal, forged, forgedConflict].map(sqlStateOf)).toEqual(['42501', '42501', '42501', '42501']);
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
        // a conflict trace is a fact as well
        yield* ingest(
          world,
          step22Double.acceptanceProven(targetOf(world, intentId, attemptId), {
            key: 'evt-ao-1',
            observedAt: yield* minutesFromNow(2),
          }),
        );
        const adminTraceUpdate = yield* refused(
          `update communications.provider_observation_conflicts set kind = 'DELIVERY_PROVEN'`,
        );
        const adminTraceDelete = yield* refused(`delete from communications.provider_observation_conflicts`);
        expect([sqlStateOf(adminTraceUpdate), sqlStateOf(adminTraceDelete)]).toEqual(['55000', '55000']);
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
