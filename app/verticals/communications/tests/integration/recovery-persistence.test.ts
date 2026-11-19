import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { intentRecoveryEvaluations, providerObservationConflictResolutions } from '../../src/database/schema.ts';
import { attemptIdOf } from '../../src/domain/intake/identity.ts';
import {
  workerBeginAttemptRoutine,
  workerBeginRetryAttemptRoutine,
  workerRecordRecoveryEvaluationRoutine,
  workerResolveObservationConflictRoutine,
} from '../../src/persistence/communications-routines.ts';
import { decideOne, ingest, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  answers,
  attemptsOf,
  conflictsOf,
  observationsOf,
  recoverableType,
  recoveriesOf,
  resolutionsOf,
  retryLinksOf,
  stepWith,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';

/**
 * [#1403] The scoped routines and constraints of the recovery lane on native PostgreSQL, as the runtime role: the database
 * itself refuses what the recovery step must never do, whatever a caller of the routines claims.
 */
const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

type Answer = Parameters<typeof handoffDouble>[0];
type IntentId = typeof MessageIntentIdSchema.Type;

const sqlStateOf = (failure: Parameters<typeof findPostgresFailure>[0]) =>
  Option.match(findPostgresFailure(failure), { onNone: () => 'none', onSome: ({ code }) => code });

const adminClient = loadDatabaseConnectionPair().pipe(
  Effect.flatMap(({ admin }) => PgClient.makeClient({ url: Redacted.make(admin.connectionString) })),
);

/** One statement as the table owner, inside the Tenant scope of the world. */
const asOwner = Effect.fn('RecoveryPersistenceTest.asOwner')(function* owner(
  world: World,
  statement: string,
  parameters: readonly unknown[] = [],
) {
  const admin = yield* adminClient;
  return yield* admin.withTransaction(
    Effect.gen(function* inOwnerScope() {
      yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
      return yield* admin.unsafe(statement, parameters);
    }),
  );
});

/** One intent whose first attempt was answered with `answer`. */
const answered = Effect.fn('RecoveryPersistenceTest.answered')(function* first(answer: Answer) {
  const world = yield* setup({ types: [recoverableType()] });
  const handoff = handoffDouble(answer);
  const { intentId } = yield* decideOne(world);
  yield* stepWith(world, handoff, intentId);
  const [attempt] = yield* attemptsOf(world, intentId);
  return { attemptId: attempt?.attemptId ?? '', intentId, world };
});

const BasisSchema = Schema.Literals(['PRIOR_NOT_ATTEMPTED', 'PRIOR_REJECTED', 'RECONCILED_NON_ACCEPTANCE']);
type Basis = typeof BasisSchema.Type;

const beginRetry = Effect.fn('RecoveryPersistenceTest.beginRetry')(function* retry(
  world: World,
  intentId: IntentId,
  previousAttemptId: string,
  basis: Basis,
  options: { readonly attemptNumber?: number; readonly observationId?: string | null } = {},
) {
  const attemptNumber = options.attemptNumber ?? 2;
  const attemptId = yield* attemptIdOf(intentId, attemptNumber);
  const rows = yield* world.database.inTenant(world.tenantId, (tx) =>
    tx.invoke(workerBeginRetryAttemptRoutine, [
      intentId,
      attemptId,
      attemptNumber,
      previousAttemptId,
      basis,
      options.observationId ?? null,
      'RETRY_FIXTURE',
    ]),
  );
  return rows[0]?.result;
});

const record = (
  world: World,
  intentId: string,
  attemptId: string,
  outcome: string,
  code: string,
  reasons: readonly object[] = [],
) =>
  world.database
    .inTenant(world.tenantId, (tx) =>
      tx.invoke(workerRecordRecoveryEvaluationRoutine, [intentId, attemptId, outcome, code, [...reasons]]),
    )
    .pipe(Effect.map((rows) => rows[0]?.result));

const resolve = (world: World, intentId: string, conflictId: string, basisId: string) =>
  world.database
    .inTenant(world.tenantId, (tx) =>
      tx.invoke(workerResolveObservationConflictRoutine, [intentId, conflictId, basisId, 'RECONCILED_FIXTURE']),
    )
    .pipe(Effect.map((rows) => rows[0]?.result));

describe('worker_begin_retry_attempt: a Technical Retry begins only on a proven basis, atomically with its link (#1403)', () => {
  it.live(
    '[R-01] follows a proven provider refusal as the next number of the SAME intent, with its link; a racing caller finds it',
    () =>
      Effect.gen(function* afterRefusal() {
        const { attemptId, intentId, world } = yield* answered(answers.rateLimited);
        expect(yield* beginRetry(world, intentId, attemptId, 'PRIOR_REJECTED')).toEqual({ outcome: 'BEGUN' });
        expect(yield* retryLinksOf(world, intentId)).toMatchObject([
          { basisKind: 'PRIOR_REJECTED', previousAttemptId: attemptId, reasonCode: 'RETRY_FIXTURE' },
        ]);
        // the same number again: the attempt exists and is PREPARED, so its owner may have called out
        expect(yield* beginRetry(world, intentId, attemptId, 'PRIOR_REJECTED')).toEqual({
          outcome: 'EXISTS',
          state: 'PREPARED',
        });
        // a number that is not the very next one is stale and writes nothing
        expect(yield* beginRetry(world, intentId, attemptId, 'PRIOR_REJECTED', { attemptNumber: 5 })).toEqual({
          outcome: 'STALE',
        });
        expect(yield* attemptsOf(world, intentId)).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-05 AC-02] a basis that does not fit the previous attempt is refused AND rolls the new attempt back: nothing is begun',
    () =>
      Effect.gen(function* wrongBasis() {
        const refused = yield* answered(answers.rateLimited);
        expect(yield* beginRetry(refused.world, refused.intentId, refused.attemptId, 'PRIOR_NOT_ATTEMPTED')).toEqual({
          outcome: 'BASIS_MISSING',
        });
        expect(yield* attemptsOf(refused.world, refused.intentId)).toHaveLength(1);
        expect(yield* retryLinksOf(refused.world, refused.intentId)).toEqual([]);
        // an unknown effect has neither a provider refusal nor an unrecorded proof as its basis
        const unknown = yield* answered(answers.timeout);
        for (const basis of ['PRIOR_NOT_ATTEMPTED', 'PRIOR_REJECTED'] as const) {
          expect(yield* beginRetry(unknown.world, unknown.intentId, unknown.attemptId, basis)).toEqual({
            outcome: 'BASIS_MISSING',
          });
        }
        expect(
          yield* beginRetry(unknown.world, unknown.intentId, unknown.attemptId, 'RECONCILED_NON_ACCEPTANCE', {
            observationId: '99999999-9999-4999-8999-999999999999',
          }),
        ).toEqual({ outcome: 'BASIS_MISSING' });
        expect(yield* attemptsOf(unknown.world, unknown.intentId)).toHaveLength(1);
        // an accepted attempt has no basis at all
        const accepted = yield* answered(answers.accepted);
        expect(yield* beginRetry(accepted.world, accepted.intentId, accepted.attemptId, 'PRIOR_REJECTED')).toEqual({
          outcome: 'BASIS_MISSING',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[R-05] evidence of an acceptance anywhere in the intent, or a conflict nobody settled, blocks every further attempt',
    () =>
      Effect.gen(function* presenceAndConflict() {
        const { attemptId, intentId, world } = yield* answered(answers.rateLimited);
        const target = targetOf(world, intentId, attemptId);
        const now = yield* DateTime.now;
        // a late acceptance observation of a refused attempt is contradictory evidence: never resolved in favour of sending
        expect(
          yield* ingest(
            world,
            step22Double.acceptanceProven(target, { key: 'a-1', observedAt: now }, 'PROVIDER_EVENT'),
          ),
        ).toBe('RECORDED');
        expect(yield* beginRetry(world, intentId, attemptId, 'PRIOR_REJECTED')).toEqual({ outcome: 'BASIS_MISSING' });

        const other = yield* answered(answers.rateLimited);
        const otherTarget = targetOf(other.world, other.intentId, other.attemptId);
        yield* ingest(other.world, step22Double.bounced(otherTarget, { key: 'b-1', observedAt: now }));
        expect(
          yield* ingest(
            other.world,
            step22Double.bounced(otherTarget, { key: 'b-1', observedAt: DateTime.add(now, { minutes: 1 }) }),
          ),
        ).toBe('CONFLICT');
        expect(yield* beginRetry(other.world, other.intentId, other.attemptId, 'PRIOR_REJECTED')).toEqual({
          outcome: 'CONFLICT_UNRESOLVED',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('worker_begin_attempt is the FIRST attempt only: every later attempt is a retry with a basis', () =>
    Effect.gen(function* firstOnly() {
      const { intentId, world } = yield* answered(() =>
        Effect.succeed({ kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' } as const),
      );
      const attemptId = yield* attemptIdOf(intentId, 2);
      const rows = yield* world.database.inTenant(world.tenantId, (tx) =>
        tx.invoke(workerBeginAttemptRoutine, [intentId, attemptId, 2]),
      );
      expect(rows[0]?.result).toEqual({ outcome: 'EXISTS', state: 'NOT_ATTEMPTED' });
      expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('worker_record_recovery_evaluation and the append-only recovery facts (#1403)', () => {
  it.live('records a halt once, appends a changed evaluation as the next number, and a PROVEN stop is final', () =>
    Effect.gen(function* evaluations() {
      const { attemptId, intentId, world } = yield* answered(answers.rateLimited);
      expect(yield* record(world, intentId, attemptId, 'HALTED', 'NO_RECOVERY_RULE')).toEqual({ outcome: 'RECORDED' });
      expect(yield* record(world, intentId, attemptId, 'HALTED', 'NO_RECOVERY_RULE')).toMatchObject({
        outcome: 'UNCHANGED',
      });
      const unproven = [{ category: 'PRIVACY_AUTHORITY_UNAVAILABLE', cause: 'OWNER_UNAVAILABLE', proven: false }];
      expect(yield* record(world, intentId, attemptId, 'STOPPED', 'PRIVACY_AUTHORITY_UNAVAILABLE', unproven)).toEqual({
        outcome: 'RECORDED',
      });
      const prohibition = [{ category: 'PRIVACY_NOT_ALLOWED', cause: 'FIXTURE', proven: true }];
      expect(yield* record(world, intentId, attemptId, 'STOPPED', 'PRIVACY_NOT_ALLOWED', prohibition)).toEqual({
        outcome: 'RECORDED',
      });
      expect(yield* record(world, intentId, attemptId, 'HALTED', 'NO_RECOVERY_RULE')).toMatchObject({
        outcome: 'FINAL',
      });
      expect(
        (yield* recoveriesOf(world, intentId)).map(
          ({ evaluationSeq, outcome, proven }) => `${String(evaluationSeq)}:${outcome}:${String(proven)}`,
        ),
      ).toEqual(['1:HALTED:false', '2:STOPPED:false', '3:STOPPED:true']);
      // an attempt of ANOTHER intent is not a basis
      const stranger = yield* answered(answers.rateLimited);
      expect(yield* record(world, intentId, stranger.attemptId, 'HALTED', 'NO_RECOVERY_RULE')).toMatchObject({
        outcome: 'MISSING',
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'the recovery facts are append-only for every role, closed by checks, and the runtime role can only read them',
    () =>
      Effect.gen(function* appendOnly() {
        const { attemptId, intentId, world } = yield* answered(answers.rateLimited);
        yield* record(world, intentId, attemptId, 'HALTED', 'NO_RECOVERY_RULE');
        for (const mutation of [
          `update communications.intent_recovery_evaluations set code = 'OTHER' where tenant_id = '${world.tenantId}'`,
          `delete from communications.intent_recovery_evaluations where tenant_id = '${world.tenantId}'`,
        ]) {
          expect(sqlStateOf(yield* Effect.flip(asOwner(world, mutation)))).toBe('55000');
        }
        // the runtime role holds no write privilege on either table
        const at = yield* DateTime.nowAsDate;
        const evaluationInsert = world.database.inTenant(world.tenantId, (tx) =>
          tx.insert(intentRecoveryEvaluations).values({
            basisAttemptId: attemptId,
            code: 'NO_RECOVERY_RULE',
            evaluatedAt: at,
            evaluationSeq: 7,
            intentId,
            outcome: 'HALTED',
            reasons: [],
            tenantId: world.tenantId,
          }),
        );
        const resolutionInsert = world.database.inTenant(world.tenantId, (tx) =>
          tx.insert(providerObservationConflictResolutions).values({
            attemptId,
            basisObservationId: attemptId,
            conflictId: attemptId,
            intentId,
            reasonCode: 'FIXTURE',
            resolutionId: attemptId,
            resolvedAt: at,
            tenantId: world.tenantId,
          }),
        );
        for (const insert of [evaluationInsert, resolutionInsert]) {
          expect(sqlStateOf(yield* Effect.flip(insert))).toBe('42501');
        }
        expect(yield* world.read((tx) => tx.select().from(intentRecoveryEvaluations))).toHaveLength(1);
        expect(yield* world.read((tx) => tx.select().from(providerObservationConflictResolutions))).toEqual([]);
        // a halt carries no stop reason and a stop carries one; a code is a closed upper-case word
        const ownerInsert = (outcome: string, code: string, reasons: string) =>
          asOwner(
            world,
            `insert into communications.intent_recovery_evaluations (tenant_id, intent_id, evaluation_seq, basis_attempt_id, outcome, code, reasons, evaluated_at)
             values ($1, $2, 9, $3, $4, $5, $6::jsonb, now())`,
            [world.tenantId, intentId, attemptId, outcome, code, reasons],
          );
        expect(sqlStateOf(yield* Effect.flip(ownerInsert('HALTED', 'NO_RECOVERY_RULE', '[{"category":"X"}]')))).toBe(
          '23514',
        );
        expect(sqlStateOf(yield* Effect.flip(ownerInsert('STOPPED', 'NO_RECOVERY_RULE', '[]')))).toBe('23514');
        expect(sqlStateOf(yield* Effect.flip(ownerInsert('HALTED', 'no recovery rule', '[]')))).toBe('23514');
        expect(sqlStateOf(yield* Effect.flip(ownerInsert('SKIPPED', 'NO_RECOVERY_RULE', '[]')))).toBe('23514');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('every recovery routine refuses a Tenant other than the installed one with 42501', () =>
    Effect.gen(function* tenantGuard() {
      const { attemptId, intentId, world } = yield* answered(answers.rateLimited);
      const stranger = '99999999-9999-4999-8999-999999999999';
      const calls = [
        sql`communications.worker_begin_retry_attempt(${stranger}::uuid, ${intentId}::uuid, ${attemptId}::uuid, 2, ${attemptId}::uuid, 'PRIOR_REJECTED', null::uuid, 'X')`,
        sql`communications.worker_record_recovery_evaluation(${stranger}::uuid, ${intentId}::uuid, ${attemptId}::uuid, 'HALTED', 'X', '[]'::jsonb)`,
        sql`communications.worker_resolve_observation_conflict(${stranger}::uuid, ${intentId}::uuid, ${attemptId}::uuid, ${attemptId}::uuid, 'X')`,
      ];
      for (const routineCall of calls) {
        const failure = yield* Effect.flip(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.select({ result: sql<unknown>`routine.result` }).from(sql`${routineCall} as routine(result)`),
          ),
        );
        expect(sqlStateOf(failure)).toBe('42501');
      }
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('worker_resolve_observation_conflict settles a conflict only by a LATER reconciliation of the same attempt (#1403)', () => {
  it.live(
    "refuses a basis that is a provider event, an earlier fact or another attempt's, and appends exactly one resolution",
    () =>
      Effect.gen(function* resolutions() {
        const { attemptId, intentId, world } = yield* answered(answers.timeout);
        const target = targetOf(world, intentId, attemptId);
        const now = yield* DateTime.now;
        // a reconciliation recorded BEFORE the conflict cannot settle a disagreement that arrived after it
        yield* ingest(world, step22Double.nonAcceptanceProven(target, { key: 'early', observedAt: now }));
        yield* ingest(world, step22Double.acceptanceProven(target, { key: 'e-1', observedAt: now }, 'PROVIDER_EVENT'));
        yield* ingest(
          world,
          step22Double.acceptanceProven(
            target,
            { key: 'e-1', observedAt: DateTime.add(now, { minutes: 1 }) },
            'PROVIDER_EVENT',
          ),
        );
        const [conflict] = yield* conflictsOf(world, intentId);
        const conflictId = conflict?.conflictId ?? '';
        const observations = yield* observationsOf(world, intentId);
        const byKind = (kind: string) =>
          observations.find((observation) => observation.kind === kind)?.observationId ?? '';
        expect(yield* resolve(world, intentId, conflictId, byKind('NON_ACCEPTANCE_PROVEN'))).toEqual({
          outcome: 'BASIS_INVALID',
        });
        // a PROVIDER_EVENT is not a reconciliation
        expect(yield* resolve(world, intentId, conflictId, byKind('ACCEPTANCE_PROVEN'))).toEqual({
          outcome: 'BASIS_INVALID',
        });
        // a conflict that does not exist in this intent
        expect(
          yield* resolve(world, intentId, '99999999-9999-4999-8999-999999999999', byKind('NON_ACCEPTANCE_PROVEN')),
        ).toEqual({ outcome: 'MISSING' });
        expect(yield* resolutionsOf(world, intentId)).toEqual([]);
        // a LATER reconciliation of the same attempt settles it, once
        yield* ingest(world, step22Double.acceptanceProven(target, { key: 'late', observedAt: now }, 'RECONCILIATION'));
        const late = (yield* observationsOf(world, intentId)).find(({ observationKey }) => observationKey === 'late');
        const lateId = late?.observationId ?? '';
        expect(yield* resolve(world, intentId, conflictId, lateId)).toEqual({ outcome: 'RESOLVED' });
        expect(yield* resolve(world, intentId, conflictId, lateId)).toEqual({ outcome: 'EXISTS' });
        expect(yield* resolve(world, intentId, conflictId, byKind('NON_ACCEPTANCE_PROVEN'))).toEqual({
          outcome: 'BASIS_INVALID',
        });
        expect(yield* resolutionsOf(world, intentId)).toHaveLength(1);
        expect(yield* conflictsOf(world, intentId)).toHaveLength(1);
        // a resolution is a fact: no role can edit or remove it, and the conflict it settles can be neither
        for (const mutation of [
          `update communications.provider_observation_conflict_resolutions set reason_code = 'OTHER' where tenant_id = '${world.tenantId}'`,
          `delete from communications.provider_observation_conflict_resolutions where tenant_id = '${world.tenantId}'`,
          `delete from communications.provider_observation_conflicts where tenant_id = '${world.tenantId}'`,
        ]) {
          expect(sqlStateOf(yield* Effect.flip(asOwner(world, mutation)))).toBe('55000');
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('the Explicit Resend reason list is closed and extended only by migration (#1403)', () => {
  it.live('accepts exactly the published business reasons', () =>
    Effect.gen(function* reasons() {
      const admin = yield* adminClient;
      const [definition] = yield* admin.unsafe<{ readonly definition: string }>(
        `select pg_catalog.pg_get_constraintdef(k.oid) as definition from pg_catalog.pg_constraint k
         where k.conrelid = 'communications.intent_resend_links'::regclass and k.conname = 'communications_resend_links_reason_ck'`,
      );
      for (const reason of [
        'PRIOR_DELIVERY_FAILED',
        'RECIPIENT_NOT_RECEIVED',
        'RECIPIENT_REQUESTED_COPY',
        'SOURCE_APPROVED_RESEND',
      ]) {
        expect(definition?.definition).toContain(`'${reason}'`);
      }
      expect(definition?.definition.match(/'[A-Z_]+'/gu)).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
