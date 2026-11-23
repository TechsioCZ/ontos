import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { cancelNeverInvokedSymmyProvision } from '../../src/administration/cancel-never-invoked-provision.ts';
import type { SymmyProvisionCancellationInput } from '../../src/administration/cancel-never-invoked-provision.ts';

const input: SymmyProvisionCancellationInput = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  jobId: '20000000-0000-4000-8000-000000000001',
  outboxMessageId: '30000000-0000-4000-8000-000000000001',
  operatorName: 'Native operator fixture',
  reason: 'Withdraw the never-invoked remainder; preserve actual accepted work',
};
const effectId = '40000000-0000-4000-8000-000000000001';
const admissionId = '50000000-0000-4000-8000-000000000001';
const pending = {
  effectId, state: 'indeterminate', version: 3, unclaimed: true, noReceipt: true,
  requestRecorded: true, owner: 'commerce.inventory',
  action: 'commerce.inventory.provision-source-stock-item', intent: 'InventoryProvision', outcome: null,
};
const accepted = {
  ...pending, effectId: '40000000-0000-4000-8000-000000000002',
  state: 'settled', owner: 'commerce.catalog', action: 'commerce.catalog.create-product',
  intent: null, noReceipt: false, outcome: 'accepted_change',
};
const originalJob = {
  admissionId, status: 'pending', attempts: 14, unclaimed: true,
  fenceState: 'open', validAdmission: true, siblings: 1,
};

const fixture = (options: {
  readonly administrative?: boolean;
  readonly readCommitted?: boolean;
  readonly job?: Partial<typeof originalJob>;
  readonly remainder?: Partial<typeof pending>;
  readonly anotherUnsettled?: boolean;
  readonly existingInvocation?: boolean;
  readonly fenceAllowed?: boolean;
  readonly auditFailure?: boolean;
  readonly updateFailure?: boolean;
} = {}) => {
  let state = { fence: 'open', remainder: { ...pending }, accepted: { ...accepted }, audits: 0 };
  let snapshot = structuredClone(state);
  const statements: { readonly sql: string; readonly parameters: readonly unknown[] }[] = [];
  const connection = testSqlConnection((query, parameters) => {
    statements.push({ sql: query, parameters });
    if (query === 'BEGIN') snapshot = structuredClone(state);
    if (query === 'ROLLBACK') state = snapshot;
    if (query.includes('session_user::text')) return Effect.succeed([{
      recordedBy: 'native_admin_fixture', administrative: options.administrative !== false,
      readCommitted: options.readCommitted !== false,
    }]);
    if (query.includes('for update of j,m,d')) return Effect.succeed(
      [input.tenantId, input.jobId, input.outboxMessageId].every((value) => parameters.includes(value))
        ? [{ ...originalJob, ...options.job }] : [],
    );
    if (query.includes('order by e.effect_id for update')) return Effect.succeed([
      state.accepted,
      { ...state.remainder, ...options.remainder },
      ...(options.anotherUnsettled ? [{ ...pending, effectId: '40000000-0000-4000-8000-000000000003' }] : []),
    ]);
    if (query.includes('trust.cancel_source_execution_fence')) {
      state.fence = 'cancelled';
      return Effect.succeed([{ allowed: options.fenceAllowed !== false }]);
    }
    if (query.includes('select action_invocation_id from core.action_invocations')) {
      // This simulates a real commit becoming visible while cancellation waited for the owner SHARE lock.
      return Effect.succeed(options.existingInvocation ? [{ action_invocation_id: admissionId }] : []);
    }
    if (query.includes('update symmy_integration.job_effects')) {
      if (options.updateFailure) return Effect.succeed([]);
      state.remainder = { ...state.remainder, state: 'settled', version: pending.version + 1 };
      return Effect.succeed([{ effect_id: effectId }]);
    }
    if (query.includes('insert into core.audit_events')) {
      if (options.auditFailure) return Effect.fail(new SqlError({
        reason: new ConnectionError({ cause: 'Controlled audit persistence failure' }),
      }));
      state.audits += 1;
    }
    return Effect.succeed([]);
  });
  const layer = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
  const cancel = (value = input) => Effect.gen(function* nativeCancellation() {
    const database = yield* testCoreDatabase;
    return yield* database.transaction((transaction) => cancelNeverInvokedSymmyProvision(transaction, value));
  }).pipe(Effect.provide(layer));
  return { cancel, statements, state: () => state };
};

it.effect('permanently fences and denies only a never-invoked remainder without rewriting accepted work or Outbox debt', () =>
  Effect.gen(function* exactNativeCancellation() {
    const current = fixture();
    expect(yield* current.cancel()).toEqual({ admissionId, effectId, jobId: input.jobId, outcome: 'denied' });
    expect(current.state()).toMatchObject({ fence: 'cancelled', remainder: { state: 'settled', version: 4 }, audits: 1 });
    expect(current.state().accepted).toEqual(accepted);
    const cancelAt = current.statements.findIndex(({ sql }) => sql.includes('trust.cancel_source_execution_fence'));
    const absenceAt = current.statements.findIndex(({ sql }) => sql.includes('select action_invocation_id'));
    const updateAt = current.statements.findIndex(({ sql }) => sql.includes('update symmy_integration.job_effects'));
    expect(cancelAt).toBeGreaterThan(0);
    expect(absenceAt).toBeGreaterThan(cancelAt);
    expect(updateAt).toBeGreaterThan(absenceAt);
    const changes = current.statements.filter(({ sql }) => /^\s*update\s/u.test(sql));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.sql).toContain("'status','denied'");
    expect(changes[0]?.sql).not.toMatch(/set[\s\S]*(?:owner_receipt|owner_invocation_id)\s*=/u);
    expect(current.statements.some(({ sql }) => /\b(?:update|delete from|insert into) core\.outbox/u.test(sql))).toBe(false);
    expect(current.statements.some(({ sql }) => /\bdelete\b/u.test(sql))).toBe(false);
  }),
);

it.effect('rejects restricted administrators and stale-snapshot isolation before cancellation or effect writes', () =>
  Effect.gen(function* authorityBoundary() {
    for (const options of [{ administrative: false }, { readCommitted: false }]) {
      const current = fixture(options);
      yield* current.cancel().pipe(Effect.flip);
      expect(current.state()).toMatchObject({ fence: 'open', audits: 0 });
      expect(current.statements.some(({ sql }) => sql.includes('trust.cancel_source_execution_fence'))).toBe(false);
    }
  }),
);

it.effect('refuses foreign identifiers, claims, other owners, receipts and multiple unfinished effects', () =>
  Effect.gen(function* exactNeverInvokedBoundary() {
    for (const value of [
      { ...input, tenantId: '10000000-0000-4000-8000-000000000002' },
      { ...input, jobId: '20000000-0000-4000-8000-000000000002' },
      { ...input, outboxMessageId: '30000000-0000-4000-8000-000000000002' },
    ]) yield* fixture().cancel(value).pipe(Effect.flip);
    for (const options of [
      { job: { unclaimed: false } }, { job: { status: 'dead' } }, { job: { attempts: 0 } },
      { job: { validAdmission: false } }, { job: { siblings: 2 } }, { job: { fenceState: 'cancelled' } },
      { remainder: { state: 'attempting' } }, { remainder: { unclaimed: false } },
      { remainder: { noReceipt: false } }, { remainder: { requestRecorded: false } },
      { remainder: { owner: 'commerce.catalog' } }, { remainder: { action: 'commerce.inventory.stock-receipt' } },
      { remainder: { intent: 'InventoryImport' } }, { anotherUnsettled: true },
    ]) {
      const current = fixture(options);
      yield* current.cancel().pipe(Effect.flip);
      expect(current.state()).toMatchObject({ fence: 'open', audits: 0 });
      expect(current.statements.some(({ sql }) => sql.includes('trust.cancel_source_execution_fence'))).toBe(false);
    }
  }),
);

it.effect('rolls back fence cancellation if any owner invocation committed while its SHARE lock was held', () =>
  Effect.gen(function* committedOwnerMustRecover() {
    const current = fixture({ existingInvocation: true });
    yield* current.cancel().pipe(Effect.flip);
    expect(current.state()).toMatchObject({ fence: 'open', remainder: pending, audits: 0 });
    expect(current.statements.some(({ sql }) => sql.includes('update symmy_integration.job_effects'))).toBe(false);
  }),
);

it.effect('rolls back the barrier and denial on barrier refusal, compare-and-set failure or missing audit', () =>
  Effect.gen(function* atomicAdministrativeDecision() {
    for (const options of [{ fenceAllowed: false }, { updateFailure: true }, { auditFailure: true }]) {
      const current = fixture(options);
      yield* current.cancel().pipe(Effect.flip);
      expect(current.state()).toMatchObject({ fence: 'open', remainder: pending, accepted, audits: 0 });
    }
  }),
);
