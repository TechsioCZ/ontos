import { DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { retryPendingOutboxDelivery } from '../../src/outbox/pending-delivery-retry.ts';
import type { PendingOutboxDeliveryRetryInput } from '../../src/outbox/pending-delivery-retry.ts';
import { testCoreDatabase } from '../../src/testing/owner-evidence.ts';
import { scriptedPgClientLayer, testSqlConnection } from '../../src/testing/scripted-pg-client.ts';

const input: PendingOutboxDeliveryRetryInput = {
  operatorName: 'Fixture operator',
  outboxMessageId: '20000000-0000-4000-8000-000000000001',
  reason: 'The missing native receiver has been enrolled and verified',
  tenantId: '10000000-0000-4000-8000-000000000001',
  workerKey: 'integration.symmy.execute-symmy-job',
};
const deliveryId = '30000000-0000-4000-8000-000000000001';
const now = '2026-11-23T07:40:00.000Z';
type DatabaseTimestamp = typeof Schema.DateTimeUtcFromString.Encoded;

interface State {
  attemptsCount: number;
  availableAt: DatabaseTimestamp;
  claimedAt: DatabaseTimestamp | null;
  claimedBy: string | null;
  claimExpiresAt: DatabaseTimestamp | null;
  status: string;
  updatedAt: DatabaseTimestamp;
}
const fixture = (
  options: Partial<State> & {
    readonly administrative?: boolean;
    readonly auditFailure?: boolean;
    readonly casFailure?: boolean;
    readonly databaseNow?: string;
  } = {},
) => {
  let state: State = {
    attemptsCount: 12,
    availableAt: '2026-11-23T07:57:21.000Z',
    claimedAt: null,
    claimedBy: null,
    claimExpiresAt: null,
    status: 'pending',
    updatedAt: '2026-11-23T07:30:00.000Z',
    ...options,
  };
  let saved = { ...state };
  const statements: { readonly parameters: readonly unknown[]; readonly sql: string }[] = [];
  const audits: unknown[] = [];
  let auditCount = 0;
  const connection = testSqlConnection((sql, parameters) => {
    statements.push({ parameters, sql });
    if (sql === 'BEGIN') {
      saved = { ...state };
      auditCount = audits.length;
    }
    if (sql === 'ROLLBACK') {
      state = saved;
      audits.splice(auditCount);
    }
    if (sql.startsWith('select') && sql.includes('inner join "core"."outbox_messages"')) {
      return Effect.succeed(
        [input.tenantId, input.outboxMessageId, input.workerKey].every((value) => parameters.includes(value))
          ? [
              [
                deliveryId,
                state.status,
                state.attemptsCount,
                state.availableAt,
                state.claimedBy,
                state.claimedAt,
                state.claimExpiresAt,
              ],
            ]
          : [],
      );
    }
    if (sql.includes('session_user')) {
      return Effect.succeed([
        {
          administrative: options.administrative !== false,
          databaseNow: options.databaseNow ?? now,
          recordedBy: options.administrative === false ? 'ontos_runtime' : 'native_admin_fixture',
        },
      ]);
    }
    if (sql.startsWith('update "core"."outbox_deliveries"')) {
      if (options.casFailure === true) {
        return Effect.succeed([]);
      }
      state = { ...state, availableAt: now, updatedAt: now };
      return Effect.succeed([{ availableAt: now }]);
    }
    if (sql.startsWith('insert into "core"."audit_events"')) {
      if (options.auditFailure === true) {
        return Effect.fail(
          new SqlError({
            reason: new ConnectionError({ cause: 'Controlled audit failure' }),
          }),
        );
      }
      audits.push(...parameters);
    }
    return Effect.succeed([]);
  });
  const layer = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
  const retry = (value = input) =>
    Effect.gen(function* actualTransaction() {
      const context = yield* Layer.build(layer);
      const database = yield* testCoreDatabase.pipe(Effect.provideContext(context));
      return yield* database.transaction((transaction) => retryPendingOutboxDelivery(transaction, value));
    }).pipe(Effect.scoped);
  return { audits, retry, state: () => state, statements };
};

it.effect(
  'reschedules exactly one tried unclaimed delivery and audits the database identity without changing durable work',
  () =>
    Effect.gen(function* retryAfterRepair() {
      const current = fixture();
      const receipt = yield* current.retry();
      expect(receipt).toMatchObject({
        attemptsCount: 12,
        availableAt: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
        outboxDeliveryId: deliveryId,
        outcome: 'RETRY_REQUESTED',
        recordedBy: 'native_admin_fixture',
        status: 'pending',
      });
      expect(current.state()).toMatchObject({ attemptsCount: 12, availableAt: now, status: 'pending', updatedAt: now });
      const lock = current.statements.find(({ sql }) => sql.includes('inner join "core"."outbox_messages"'));
      expect(lock?.sql).toContain('for update');
      for (const value of [input.tenantId, input.outboxMessageId, input.workerKey]) {
        expect(lock?.parameters).toContain(value);
      }
      const update = current.statements.find(({ sql }) => sql.startsWith('update "core"."outbox_deliveries"'));
      expect(update?.sql.split(' where ')[0]).toMatch(/set "available_at" = .*"updated_at" =/u);
      expect(update?.sql.split(' where ')[0]).not.toMatch(/status|attempts_count|claim|payload|completion/u);
      expect(update?.sql).toContain('"claimed_by" is null');
      expect(update?.sql).toContain('"claimed_at" is null');
      expect(update?.sql).toContain('"claim_expires_at" is null');
      const auditText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(current.audits);
      expect(auditText).toContain('native_admin_fixture');
      expect(auditText).toContain(input.operatorName);
      const audit = current.statements.find(({ sql }) => sql.startsWith('insert into "core"."audit_events"'));
      expect(audit?.parameters).toContain('system');
      expect(audit?.parameters).toContain(null);
      expect(
        current.statements.some(
          ({ sql }) => sql.startsWith('update ') && !sql.startsWith('update "core"."outbox_deliveries"'),
        ),
      ).toBe(false);
    }),
);

it.effect('returns ALREADY_DUE without moving its schedule or resetting the attempt budget', () =>
  Effect.gen(function* alreadyDue() {
    const availableAt = '2026-11-23T07:39:59.000Z';
    const current = fixture({ availableAt });
    expect(yield* current.retry()).toMatchObject({
      attemptsCount: 12,
      availableAt: DateTime.toDateUtc(DateTime.makeUnsafe(availableAt)),
      outcome: 'ALREADY_DUE',
    });
    expect(current.statements.some(({ sql }) => sql.startsWith('update '))).toBe(false);
    expect(current.audits.length).toBeGreaterThan(0);
  }),
);

it.effect('refuses an invalid database clock without changing the delivery or writing an audit', () =>
  Effect.gen(function* invalidDatabaseClock() {
    const current = fixture({ databaseNow: 'not-a-database-instant' });
    expect(yield* current.retry().pipe(Effect.flip)).toMatchObject({ code: 'outbox_retry_unavailable' });
    expect(current.statements.some(({ sql }) => /^(?:insert|update) /u.test(sql))).toBe(false);
    expect(current.audits).toEqual([]);
  }),
);

it.effect(
  'refuses the runtime database identity without native operator-ledger INSERT authority before any write',
  () =>
    Effect.gen(function* administrativeCapabilityRequired() {
      for (const availableAt of ['2026-11-23T07:57:21.000Z', '2026-11-23T07:39:59.000Z']) {
        const current = fixture({ administrative: false, availableAt });
        expect(yield* current.retry().pipe(Effect.flip)).toMatchObject({ code: 'outbox_retry_forbidden' });
        expect(current.statements.some(({ sql }) => /^(?:insert|update) /u.test(sql))).toBe(false);
        expect(current.state().availableAt).toBe(availableAt);
        const facts = current.statements.find(({ sql }) => sql.includes('has_table_privilege'));
        expect(facts?.sql).toContain("has_table_privilege(session_user, 'core.outbox_delivery_resolutions', 'INSERT')");
      }
    }),
);

it.effect('refuses foreign references, every nonpending state, untried work and every residual claim field', () =>
  Effect.gen(function* refusedRetries() {
    for (const value of [
      { ...input, tenantId: '10000000-0000-4000-8000-000000000002' },
      { ...input, outboxMessageId: '20000000-0000-4000-8000-000000000002' },
      { ...input, workerKey: 'another.worker' },
    ]) {
      expect(yield* fixture().retry(value).pipe(Effect.flip)).toMatchObject({ code: 'outbox_delivery_not_found' });
    }
    for (const options of [
      ...['processing', 'done', 'dead', 'released'].map((status) => ({ status })),
      { attemptsCount: 0 },
      { claimedBy: 'live-worker' },
      { claimedAt: now },
      { claimExpiresAt: now },
    ]) {
      const current = fixture(options);
      expect(yield* current.retry().pipe(Effect.flip)).toMatchObject({ code: 'outbox_delivery_not_retryable' });
      expect(current.statements.some(({ sql }) => /^(?:insert|update) /u.test(sql))).toBe(false);
    }
  }),
);

it.effect('validates bounded operator input before SQL and refuses a failed CAS', () =>
  Effect.gen(function* invalidInputAndCas() {
    for (const value of [
      { ...input, operatorName: '' },
      { ...input, operatorName: 'x'.repeat(201) },
      { ...input, reason: ' ' },
      { ...input, reason: 'x'.repeat(2001) },
      { ...input, outboxMessageId: 'not-a-uuid' },
    ]) {
      const current = fixture();
      expect(yield* current.retry(value).pipe(Effect.flip)).toMatchObject({ code: 'outbox_retry_invalid_input' });
      expect(current.statements.some(({ sql }) => !['BEGIN', 'ROLLBACK'].includes(sql))).toBe(false);
    }
    const current = fixture({ casFailure: true });
    expect(yield* current.retry().pipe(Effect.flip)).toMatchObject({ code: 'outbox_retry_compare_and_set_failed' });
    expect(current.audits).toEqual([]);
  }),
);

it.effect('propagates an audit failure so the caller transaction rolls back the schedule change', () =>
  Effect.gen(function* atomicAuditFailure() {
    const current = fixture({ auditFailure: true });
    const original = { ...current.state() };
    expect(yield* current.retry().pipe(Effect.flip)).toMatchObject({ code: 'outbox_retry_unavailable' });
    expect(current.statements.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(current.statements.some(({ sql }) => sql === 'COMMIT')).toBe(false);
    expect(current.state()).toEqual(original);
  }),
);
