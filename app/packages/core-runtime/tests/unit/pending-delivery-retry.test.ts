import { Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { retryPendingOutboxDelivery } from '../../src/outbox/pending-delivery-retry.ts';
import type { PendingOutboxDeliveryRetryInput } from '../../src/outbox/pending-delivery-retry.ts';
import { testCoreDatabase } from '../../src/testing/owner-evidence.ts';
import { scriptedPgClientLayer, testSqlConnection } from '../../src/testing/scripted-pg-client.ts';

const input: PendingOutboxDeliveryRetryInput = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  outboxMessageId: '20000000-0000-4000-8000-000000000001',
  workerKey: 'integration.symmy.execute-symmy-job',
  operatorName: 'Fixture operator',
  reason: 'The missing native receiver has been enrolled and verified',
};
const deliveryId = '30000000-0000-4000-8000-000000000001';
const now = '2026-11-23T07:40:00.000Z';
interface State {
  status: string;
  attemptsCount: number;
  availableAt: string;
  updatedAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
}
const fixture = (options: Partial<State> & {
  readonly auditFailure?: boolean; readonly casFailure?: boolean; readonly administrative?: boolean;
} = {}) => {
  let state: State = {
    status: 'pending', attemptsCount: 12, availableAt: '2026-11-23T07:57:21.000Z',
    updatedAt: '2026-11-23T07:30:00.000Z', claimedBy: null, claimedAt: null, claimExpiresAt: null, ...options,
  };
  let saved = { ...state };
  const statements: { readonly sql: string; readonly parameters: readonly unknown[] }[] = [];
  const audits: unknown[] = [];
  let auditCount = 0;
  const connection = testSqlConnection((sql, parameters) => {
    statements.push({ sql, parameters });
    if (sql === 'BEGIN') { saved = { ...state }; auditCount = audits.length; }
    if (sql === 'ROLLBACK') { state = saved; audits.splice(auditCount); }
    if (sql.startsWith('select') && sql.includes('inner join "core"."outbox_messages"')) {
      return Effect.succeed(
        [input.tenantId, input.outboxMessageId, input.workerKey].every((value) => parameters.includes(value))
          ? [{
              outboxDeliveryId: deliveryId, status: state.status, attemptsCount: state.attemptsCount,
              availableAt: state.availableAt, claimedBy: state.claimedBy,
              claimedAt: state.claimedAt, claimExpiresAt: state.claimExpiresAt,
            }]
          : [],
      );
    }
    if (sql.includes('session_user')) {
      return Effect.succeed([{
        databaseNow: now, recordedBy: options.administrative === false ? 'ontos_runtime' : 'native_admin_fixture',
        administrative: options.administrative !== false,
      }]);
    }
    if (sql.startsWith('update "core"."outbox_deliveries"')) {
      if (options.casFailure) return Effect.succeed([]);
      state = { ...state, availableAt: now, updatedAt: now };
      return Effect.succeed([{ availableAt: now }]);
    }
    if (sql.startsWith('insert into "core"."audit_events"')) {
      if (options.auditFailure) return Effect.fail(new SqlError({
        reason: new ConnectionError({ cause: 'Controlled audit failure' }),
      }));
      audits.push(...parameters);
    }
    return Effect.succeed([]);
  });
  const layer = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
  const retry = (value = input) => Effect.gen(function* actualTransaction() {
    const database = yield* testCoreDatabase;
    return yield* database.transaction((transaction) => retryPendingOutboxDelivery(transaction, value));
  }).pipe(Effect.provide(layer));
  return { retry, statements, audits, state: () => state };
};

it.effect('reschedules exactly one tried unclaimed delivery and audits the database identity without changing durable work', () =>
  Effect.gen(function* retryAfterRepair() {
    const current = fixture();
    const receipt = yield* current.retry();
    expect(receipt).toMatchObject({
      outcome: 'RETRY_REQUESTED', status: 'pending', attemptsCount: 12, outboxDeliveryId: deliveryId,
      recordedBy: 'native_admin_fixture', availableAt: new Date(now),
    });
    expect(current.state()).toMatchObject({ status: 'pending', attemptsCount: 12, availableAt: now, updatedAt: now });
    const lock = current.statements.find(({ sql }) => sql.includes('inner join "core"."outbox_messages"'));
    expect(lock?.sql).toContain('for update');
    for (const value of [input.tenantId, input.outboxMessageId, input.workerKey]) expect(lock?.parameters).toContain(value);
    const update = current.statements.find(({ sql }) => sql.startsWith('update "core"."outbox_deliveries"'));
    expect(update?.sql.split(' where ')[0]).toMatch(/set "available_at" = .*"updated_at" =/u);
    expect(update?.sql.split(' where ')[0]).not.toMatch(/status|attempts_count|claim|payload|completion/u);
    expect(update?.sql).toContain('"claimed_by" is null');
    expect(update?.sql).toContain('"claimed_at" is null');
    expect(update?.sql).toContain('"claim_expires_at" is null');
    expect(JSON.stringify(current.audits)).toContain('native_admin_fixture');
    expect(JSON.stringify(current.audits)).toContain(input.operatorName);
    const audit = current.statements.find(({ sql }) => sql.startsWith('insert into "core"."audit_events"'));
    expect(audit?.parameters).toContain('system');
    expect(audit?.parameters).toContain(null);
    expect(current.statements.some(({ sql }) => /^update /u.test(sql) && !sql.startsWith('update "core"."outbox_deliveries"'))).toBe(false);
  }),
);

it.effect('returns ALREADY_DUE without moving its schedule or resetting the attempt budget', () =>
  Effect.gen(function* alreadyDue() {
    const availableAt = '2026-11-23T07:39:59.000Z';
    const current = fixture({ availableAt });
    expect(yield* current.retry()).toMatchObject({ outcome: 'ALREADY_DUE', attemptsCount: 12, availableAt: new Date(availableAt) });
    expect(current.statements.some(({ sql }) => sql.startsWith('update '))).toBe(false);
    expect(current.audits.length).toBeGreaterThan(0);
  }),
);

it.effect('refuses the runtime database identity without native operator-ledger INSERT authority before any write', () =>
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
      { attemptsCount: 0 }, { claimedBy: 'live-worker' }, { claimedAt: now }, { claimExpiresAt: now },
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
      { ...input, operatorName: '' }, { ...input, operatorName: 'x'.repeat(201) },
      { ...input, reason: ' ' }, { ...input, reason: 'x'.repeat(2001) }, { ...input, outboxMessageId: 'not-a-uuid' },
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
