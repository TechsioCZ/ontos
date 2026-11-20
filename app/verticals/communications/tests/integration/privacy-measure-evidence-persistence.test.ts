import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { StoredJson } from '../../src/database/schema.ts';
import { privacyExecutionEvidence, privacyMeasureHandoffs } from '../../src/database/schema.ts';
import {
  readPrivacyMeasureHandoffRoutine,
  recordPrivacyExecutionEvidenceRoutine,
  workerRecordPrivacyMeasureHandoffRoutine,
} from '../../src/persistence/communications-routines.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

/**
 * [#1410] The Privacy measure handoff and execution evidence tables and their routines on native PostgreSQL, as the runtime role:
 * the database itself keeps them append-only, Tenant-isolated and writable only through the scoped routines. The evidence only
 * RECORDS what a human confirmed; nothing here executes a measure.
 */
/** A jsonb parameter: an array or an object, never a bare scalar. */
type JsonbDocument = readonly StoredJson[] | Readonly<Record<string, StoredJson>>;
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const SCOPE_DIGEST = 'c'.repeat(64);
const OTHER_SCOPE_DIGEST = 'd'.repeat(64);
const TARGETS = ['communications.request:r-1', 'communications.intent:i-1'];
const INVOCATION = '00000000-0000-4000-8000-0000000000c1';
const CONFIRMATION = '00000000-0000-4000-8000-0000000000c2';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** What the write routines answer: the outcome and, when there is one, the stored document. */
const WriteAnswer = Schema.Struct({
  evidence: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.String,
  record: Schema.optionalKey(Schema.Unknown),
});
const ReadAnswer = Schema.Struct({ evidence: Schema.Array(Schema.Unknown), record: Schema.Unknown });
const decodeWrite = Schema.decodeUnknownSync(WriteAnswer);
const decodeRead = Schema.decodeUnknownSync(ReadAnswer);

const sqlStateOf = (failure: Parameters<typeof findPostgresFailure>[0]) =>
  Option.match(findPostgresFailure(failure), { onNone: () => 'none', onSome: ({ code }) => code });

const adminClient = loadDatabaseConnectionPair().pipe(
  Effect.flatMap(({ admin }) => PgClient.makeClient({ url: Redacted.make(admin.connectionString) })),
);

const setup = Effect.gen(function* setupWorld() {
  const database = yield* makeRuntimeDatabase();
  return { database, otherTenantId: yield* nextId, tenantId: yield* nextId };
});

interface HandoffOptions {
  readonly fingerprint?: string;
  readonly revision?: number;
  readonly scopeDigest?: string;
  readonly targets?: JsonbDocument;
}

const handoffArguments = (key: string, options: HandoffOptions = {}) =>
  [
    key,
    'measure-1',
    'task-1',
    'decision-1',
    options.revision ?? 1,
    options.fingerprint ?? FINGERPRINT,
    options.scopeDigest ?? SCOPE_DIGEST,
    options.targets ?? TARGETS,
    INVOCATION,
  ] as const;

type World = Effect.Success<typeof setup>;
type Results = readonly { readonly contentRef: string; readonly result: string }[];

const recordHandoff = (world: World, key: string, options: HandoffOptions = {}, tenantId = world.tenantId) =>
  world.database
    .inTenant(tenantId, (tx) =>
      tx.invoke(workerRecordPrivacyMeasureHandoffRoutine, [...handoffArguments(key, options)]),
    )
    .pipe(Effect.map((rows) => decodeWrite(rows[0]?.result)));

const recordEvidence = (
  world: World,
  evidenceRef: string,
  key: string,
  phase: string,
  results: JsonbDocument,
  scopeDigest = SCOPE_DIGEST,
  tenantId = world.tenantId,
) =>
  world.database
    .inTenant(tenantId, (tx) =>
      tx.invoke(recordPrivacyExecutionEvidenceRoutine, [evidenceRef, key, phase, results, scopeDigest, CONFIRMATION]),
    )
    .pipe(Effect.map((rows) => decodeWrite(rows[0]?.result)));

const readHandoff = (world: World, key: string, tenantId = world.tenantId) =>
  world.database
    .inTenant(tenantId, (tx) => tx.invoke(readPrivacyMeasureHandoffRoutine, [key]))
    .pipe(Effect.map((rows) => decodeRead(rows[0]?.result)));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * One routine called as the SQL a forged or careless caller would send, so the failure keeps its PostgreSQL error code (the
 * routine invoker reports a failed call under its own redacted code).
 */
const failureOfRawCall = (world: World, routineCall: ReturnType<typeof sql>) =>
  world.database
    .inTenant(world.tenantId, (tx) =>
      tx.select({ result: sql<unknown>`routine.result` }).from(sql`${routineCall} as routine(result)`),
    )
    .pipe(Effect.flip, Effect.map(sqlStateOf));

const refusedHandoff = (world: World, key: string, options: HandoffOptions = {}) => {
  const [, measure, task, decision, revision, fingerprint, scopeDigest, targets] = handoffArguments(key, options);
  return failureOfRawCall(
    world,
    sql`communications.worker_record_privacy_measure_handoff(${world.tenantId}::uuid, ${key}, ${measure}, ${task}, ${decision}, ${revision}, ${fingerprint}, ${scopeDigest}, ${encodeJson(targets)}::jsonb, ${INVOCATION}::uuid)`,
  );
};

const refusedEvidence = (world: World, phase: string, results: JsonbDocument) =>
  failureOfRawCall(
    world,
    sql`communications.record_privacy_execution_evidence(${world.tenantId}::uuid, 'ev-bad', 'key-1', ${phase}, ${encodeJson(results)}::jsonb, ${SCOPE_DIGEST}, ${CONFIRMATION}::uuid)`,
  );

const completed: Results = [
  { contentRef: TARGETS[0] ?? '', result: 'ANONYMIZED' },
  { contentRef: TARGETS[1] ?? '', result: 'NOT_EXECUTED' },
];

const storedRecord = (key: string, fingerprint = FINGERPRINT, revision = 1) => ({
  handoffFingerprint: fingerprint,
  idempotencyKey: key,
  measureId: 'measure-1',
  scopeDigest: SCOPE_DIGEST,
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: revision,
  targetContentRefs: TARGETS,
  taskId: 'task-1',
});

describe('worker_record_privacy_measure_handoff: the first writer of an idempotency key wins (#1410)', () => {
  it.live('records, replays and reports a conflict with the stored record, writing exactly one row', () =>
    Effect.gen(function* handoffOutcomes() {
      const world = yield* setup;
      const recorded = yield* recordHandoff(world, 'key-1');
      expect(recorded).toMatchObject({ outcome: 'RECORDED', record: storedRecord('key-1') });
      expect(recorded).toMatchObject({ record: { receivedAt: expect.stringMatching(ISO_MILLISECONDS) } });
      expect(yield* recordHandoff(world, 'key-1')).toEqual({ ...recorded, outcome: 'EXISTS' });
      // the same key with another fingerprint: the STORED record comes back and nothing changes
      const conflicting = yield* recordHandoff(world, 'key-1', { fingerprint: OTHER_FINGERPRINT, revision: 2 });
      expect(conflicting).toMatchObject({ outcome: 'CONFLICT', record: storedRecord('key-1') });
      const rows = yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyMeasureHandoffs));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        handoffFingerprint: FINGERPRINT,
        originatorInvocationId: INVOCATION,
        tenantId: world.tenantId,
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('lets exactly one of two racing callers record, and the other finds the same record', () =>
    Effect.gen(function* racing() {
      const world = yield* setup;
      const outcomes = yield* Effect.all([recordHandoff(world, 'race'), recordHandoff(world, 'race')], {
        concurrency: 2,
      });
      expect(outcomes.map(({ outcome }) => outcome).toSorted()).toEqual(['EXISTS', 'RECORDED']);
      expect(
        (yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyMeasureHandoffs))).length,
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses a malformed handoff with a check violation and records nothing', () =>
    Effect.gen(function* malformed() {
      const world = yield* setup;
      const refused: readonly HandoffOptions[] = [
        { fingerprint: 'not-a-digest' },
        { scopeDigest: 'A'.repeat(64) },
        { revision: 0 },
        { targets: [] },
        { targets: [1] },
        { targets: [''] },
        { targets: { 0: 'x' } },
      ];
      for (const options of refused) {
        expect(yield* refusedHandoff(world, 'bad', options)).toBe('23514');
      }
      expect(yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyMeasureHandoffs))).toEqual(
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('record_privacy_execution_evidence: records human-confirmed evidence and nothing else (#1410)', () => {
  it.live('answers every outcome and always carries the stored evidence when there is one', () =>
    Effect.gen(function* evidenceOutcomes() {
      const world = yield* setup;
      // no handoff under the key: nothing is recorded
      expect(yield* recordEvidence(world, 'ev-0', 'missing', 'RECEIVED', [])).toEqual({ outcome: 'NO_HANDOFF' });
      yield* recordHandoff(world, 'key-1');
      expect(yield* recordEvidence(world, 'ev-0', 'key-1', 'RECEIVED', [], OTHER_SCOPE_DIGEST)).toEqual({
        outcome: 'SCOPE_MISMATCH',
      });
      expect(
        yield* recordEvidence(world, 'ev-0', 'key-1', 'COMPLETED', [
          { contentRef: 'communications.request:other', result: 'REMOVED' },
        ]),
      ).toEqual({ outcome: 'TARGET_MISMATCH' });
      const received = yield* recordEvidence(world, 'ev-1', 'key-1', 'RECEIVED', []);
      expect(received).toMatchObject({
        evidence: {
          confirmationInvocationId: CONFIRMATION,
          evidenceRef: 'ev-1',
          phase: 'RECEIVED',
          results: [],
          scopeDigest: SCOPE_DIGEST,
        },
        outcome: 'RECORDED',
      });
      expect(received).toMatchObject({ evidence: { recordedAt: expect.stringMatching(ISO_MILLISECONDS) } });
      expect(yield* recordEvidence(world, 'ev-1', 'key-1', 'RECEIVED', [])).toEqual({ ...received, outcome: 'EXISTS' });
      // the same evidence ref with other content: the STORED evidence comes back and nothing changes
      expect(yield* recordEvidence(world, 'ev-1', 'key-1', 'IN_PROGRESS', [])).toEqual({
        ...received,
        outcome: 'CONFLICT',
      });
      expect(yield* recordEvidence(world, 'ev-2', 'key-1', 'COMPLETED', completed)).toMatchObject({
        evidence: { evidenceRef: 'ev-2', phase: 'COMPLETED', results: completed },
        outcome: 'RECORDED',
      });
      const rows = yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyExecutionEvidence));
      expect(rows.map((row) => row.evidenceRef).toSorted()).toEqual(['ev-1', 'ev-2']);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses evidence of a malformed shape with a check violation and records nothing', () =>
    Effect.gen(function* malformedEvidence() {
      const world = yield* setup;
      yield* recordHandoff(world, 'key-1');
      const target = TARGETS[0] ?? '';
      const refused: readonly (readonly [string, JsonbDocument])[] = [
        // a RECEIVED phase has no result yet
        ['RECEIVED', [{ contentRef: target, result: 'ANONYMIZED' }]],
        ['COMPLETED', [{ contentRef: target, result: 'DELETED' }]],
        ['COMPLETED', [{ contentRef: target, note: 'free text', result: 'ANONYMIZED' }]],
        ['COMPLETED', [{ result: 'ANONYMIZED' }]],
        ['COMPLETED', [{ contentRef: 1, result: 'ANONYMIZED' }]],
        ['COMPLETED', ['ANONYMIZED']],
        ['COMPLETED', { contentRef: target, result: 'ANONYMIZED' }],
        ['STARTED', []],
      ];
      for (const [phase, results] of refused) {
        expect(yield* refusedEvidence(world, phase, results)).toBe('23514');
      }
      expect(
        yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyExecutionEvidence)),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('accepts every closed result value', () =>
    Effect.gen(function* closedResults() {
      const world = yield* setup;
      yield* recordHandoff(world, 'key-1');
      const values = [
        'ANONYMIZED',
        'FAILED_AFTER_POSSIBLE_MUTATION',
        'FAILED_BEFORE_ANY_MUTATION',
        'NOT_EXECUTED',
        'RECTIFIED',
        'REMOVED',
        'RESTRICTED',
      ];
      for (const value of values) {
        expect(
          yield* recordEvidence(world, `ev-${value}`, 'key-1', 'COMPLETED', [
            { contentRef: TARGETS[0] ?? '', result: value },
          ]),
        ).toMatchObject({ outcome: 'RECORDED' });
      }
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('read_privacy_measure_handoff: the record and its evidence, oldest first (#1410)', () => {
  it.live('answers a null record and no evidence for an unknown key, then the record with its evidence in order', () =>
    Effect.gen(function* reads() {
      const world = yield* setup;
      expect(yield* readHandoff(world, 'key-1')).toEqual({ evidence: [], record: null });
      yield* recordHandoff(world, 'key-1');
      yield* recordEvidence(world, 'ev-b', 'key-1', 'RECEIVED', []);
      yield* recordEvidence(world, 'ev-a', 'key-1', 'COMPLETED', completed);
      const answer = yield* readHandoff(world, 'key-1');
      expect(answer.record).toMatchObject({
        ...storedRecord('key-1'),
        receivedAt: expect.stringMatching(ISO_MILLISECONDS),
      });
      expect(answer.evidence).toMatchObject([
        { evidenceRef: 'ev-b', recordedAt: expect.stringMatching(ISO_MILLISECONDS) },
        { evidenceRef: 'ev-a', recordedAt: expect.stringMatching(ISO_MILLISECONDS) },
      ]);
      expect(answer.evidence[1]).toMatchObject({
        confirmationInvocationId: CONFIRMATION,
        phase: 'COMPLETED',
        results: completed,
        scopeDigest: SCOPE_DIGEST,
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('Tenant isolation, privileges and append-only guards on PostgreSQL (#1410)', () => {
  it.live('keeps every Tenant to its own handoffs and evidence, even under the same keys', () =>
    Effect.gen(function* isolation() {
      const world = yield* setup;
      yield* recordHandoff(world, 'shared-key');
      yield* recordEvidence(world, 'ev-1', 'shared-key', 'RECEIVED', []);
      const other = world.otherTenantId;
      expect(yield* readHandoff(world, 'shared-key', other)).toEqual({ evidence: [], record: null });
      expect(yield* recordEvidence(world, 'ev-1', 'shared-key', 'RECEIVED', [], SCOPE_DIGEST, other)).toEqual({
        outcome: 'NO_HANDOFF',
      });
      expect(yield* world.database.inTenant(other, (tx) => tx.select().from(privacyMeasureHandoffs))).toEqual([]);
      expect(yield* world.database.inTenant(other, (tx) => tx.select().from(privacyExecutionEvidence))).toEqual([]);
      // the same key is a different handoff in another Tenant
      expect(yield* recordHandoff(world, 'shared-key', { fingerprint: OTHER_FINGERPRINT }, other)).toMatchObject({
        outcome: 'RECORDED',
      });
      expect(yield* readHandoff(world, 'shared-key')).toMatchObject({ record: { handoffFingerprint: FINGERPRINT } });
      expect(yield* readHandoff(world, 'shared-key', other)).toMatchObject({
        record: { handoffFingerprint: OTHER_FINGERPRINT },
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('lets the runtime role read both tables and nothing else: no insert, update, delete or truncate', () =>
    Effect.gen(function* privileges() {
      const world = yield* setup;
      yield* recordHandoff(world, 'key-1');
      yield* recordEvidence(world, 'ev-1', 'key-1', 'RECEIVED', []);
      const { tenantId } = world;
      const now = yield* DateTime.nowAsDate;
      const attempts = [
        world.database.inTenant(tenantId, (tx) =>
          tx.insert(privacyMeasureHandoffs).values({
            handoffFingerprint: FINGERPRINT,
            idempotencyKey: 'direct',
            measureId: 'measure-1',
            originatorInvocationId: INVOCATION,
            receivedAt: now,
            scopeDigest: SCOPE_DIGEST,
            sourceDecisionRef: 'decision-1',
            sourceDecisionRevision: 1,
            targetContentRefs: TARGETS,
            taskId: 'task-1',
            tenantId,
          }),
        ),
        world.database.inTenant(tenantId, (tx) =>
          tx.insert(privacyExecutionEvidence).values({
            confirmationInvocationId: CONFIRMATION,
            evidenceRef: 'direct',
            idempotencyKey: 'key-1',
            phase: 'RECEIVED',
            recordedAt: now,
            results: [],
            scopeDigest: SCOPE_DIGEST,
            tenantId,
          }),
        ),
        world.database.inTenant(tenantId, (tx) => tx.update(privacyMeasureHandoffs).set({ measureId: 'other' })),
        world.database.inTenant(tenantId, (tx) => tx.update(privacyExecutionEvidence).set({ phase: 'COMPLETED' })),
        world.database.inTenant(tenantId, (tx) => tx.delete(privacyMeasureHandoffs)),
        world.database.inTenant(tenantId, (tx) => tx.delete(privacyExecutionEvidence)),
      ];
      const causes = yield* Effect.forEach(attempts, (attempt) => attempt.pipe(Effect.flip, Effect.map(sqlStateOf)), {
        concurrency: 1,
      });
      expect(causes).toEqual(attempts.map(() => '42501'));
      expect(yield* world.database.inTenant(tenantId, (tx) => tx.select().from(privacyMeasureHandoffs))).toHaveLength(
        1,
      );
      expect(yield* world.database.inTenant(tenantId, (tx) => tx.select().from(privacyExecutionEvidence))).toHaveLength(
        1,
      );
      // TRUNCATE is not a row statement: the table privileges themselves prove the runtime role holds none of the writing verbs
      const admin = yield* adminClient;
      const tablePrivileges = yield* admin.unsafe<{ readonly granted: readonly string[]; readonly name: string }>(
        `select c.relname as name,
          array(select verb from unnest(array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) as verb
            where has_table_privilege('ontos_runtime', c.oid, verb)) as granted
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'communications' and c.relname in ('privacy_execution_evidence', 'privacy_measure_handoffs')
        order by c.relname`,
      );
      expect(tablePrivileges).toEqual([
        { granted: ['SELECT'], name: 'privacy_execution_evidence' },
        { granted: ['SELECT'], name: 'privacy_measure_handoffs' },
      ]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('rejects an update or delete by trigger even for the table owner', () =>
    Effect.gen(function* appendOnly() {
      const world = yield* setup;
      yield* recordHandoff(world, 'key-1');
      yield* recordEvidence(world, 'ev-1', 'key-1', 'RECEIVED', []);
      const admin = yield* adminClient;
      for (const mutation of [
        `update communications.privacy_measure_handoffs set measure_id = 'other' where tenant_id = '${world.tenantId}'`,
        `delete from communications.privacy_measure_handoffs where tenant_id = '${world.tenantId}'`,
        `update communications.privacy_execution_evidence set phase = 'COMPLETED' where tenant_id = '${world.tenantId}'`,
        `delete from communications.privacy_execution_evidence where tenant_id = '${world.tenantId}'`,
      ]) {
        const failure = yield* Effect.flip(
          admin.withTransaction(
            Effect.gen(function* inOwnerScope() {
              yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
              return yield* admin.unsafe(mutation);
            }),
          ),
        );
        expect(sqlStateOf(failure)).toBe('55000');
      }
      expect(yield* readHandoff(world, 'key-1')).toMatchObject({
        evidence: [{ evidenceRef: 'ev-1', phase: 'RECEIVED' }],
        record: { measureId: 'measure-1' },
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses every routine a Tenant other than the installed one with 42501', () =>
    Effect.gen(function* tenantGuard() {
      const world = yield* setup;
      type Tx = Parameters<Parameters<World['database']['inTenant']>[1]>[0];
      const call = (tx: Tx, routineCall: ReturnType<typeof sql>) =>
        tx.select({ result: sql<unknown>`routine.result` }).from(sql`${routineCall} as routine(result)`);
      const calls = [
        sql`communications.worker_record_privacy_measure_handoff(${STRANGER}::uuid, 'key-1', 'measure-1', 'task-1', 'decision-1', 1, ${FINGERPRINT}, ${SCOPE_DIGEST}, '["communications.request:r-1"]'::jsonb, ${INVOCATION}::uuid)`,
        sql`communications.read_privacy_measure_handoff(${STRANGER}::uuid, 'key-1')`,
        sql`communications.record_privacy_execution_evidence(${STRANGER}::uuid, 'ev-1', 'key-1', 'RECEIVED', '[]'::jsonb, ${SCOPE_DIGEST}, ${CONFIRMATION}::uuid)`,
      ];
      for (const routineCall of calls) {
        const failure = yield* Effect.flip(world.database.inTenant(world.tenantId, (tx) => call(tx, routineCall)));
        expect(sqlStateOf(failure)).toBe('42501');
      }
      // the same call naming the installed Tenant is answered: the guard refuses the Tenant, not the routine
      const own = yield* world.database.inTenant(world.tenantId, (tx) =>
        call(tx, sql`communications.read_privacy_measure_handoff(${world.tenantId}::uuid, 'key-1')`),
      );
      expect(own).toHaveLength(1);
      expect(yield* world.database.inTenant(world.tenantId, (tx) => tx.select().from(privacyMeasureHandoffs))).toEqual(
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
