import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { Effect, Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { customerNewsletterScope } from '../../api/portal-auth/consent/model.ts';

const tenantId = 'e1000000-0000-4000-8000-000000000001';
const legalEntityId = 'e2000000-0000-4000-8000-000000000002';
const partyId = 'e3000000-0000-4000-8000-000000000003';
const receiptId = 'e4000000-0000-4000-8000-000000000004';
const anotherTenant = 'e1000000-0000-4000-8000-000000000005';
const anotherEntity = 'e2000000-0000-4000-8000-000000000006';
const receipt = {
  acknowledgedAt: '2026-10-23T12:00:00.000Z',
  decision: 'GRANTED',
  noticeVersionId: 'e5000000-0000-4000-8000-000000000007',
  partyId,
  providedLanguage: 'cs',
  providerSubjectId: 'postgres-receipt-provider-subject',
  requestId: receiptId,
  scope: customerNewsletterScope({
    controllerRef: legalEntityId,
    partyId,
    purposeId: 'e6000000-0000-4000-8000-000000000008',
    purposeMeaning: 'Voluntary email newsletter',
    purposeVersionId: 'e7000000-0000-4000-8000-000000000009',
    tenantId,
  }),
  sessionRef: 'postgres-receipt-session',
};

it.live(
  'persists immutable receipt replay through only scoped runtime routines and isolates tenant/legal entity',
  Effect.fn('CustomerConsentReceipt.postgres')(function* receiptPostgres() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* makeTestPgClient(connections.admin.connectionString);
    const runtime = yield* makeTestPgClient(connections.runtime.connectionString);
    const cleanup = admin.withTransaction(
      Effect.gen(function* cleanOwnedReceipt() {
        yield* admin`set local session_replication_role = 'replica'`;
        yield* admin`delete from commerce_customer_context.customer_consent_receipts where receipt_id = ${receiptId}::uuid`;
      }),
    );
    yield* cleanup;
    yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));
    const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>, tenant = tenantId, entity = legalEntityId) =>
      runtime.withTransaction(
        Effect.gen(function* transaction() {
          yield* runtime`select set_config('ontos.tenant_id', ${tenant}, true), set_config('ontos.legal_entity_id', ${entity}, true)`;
          return yield* effect;
        }),
      );
    const write = (value = receipt, tenant = tenantId, entity = legalEntityId) =>
      runtime<{
        receipt: unknown;
      }>`select * from commerce_customer_context.write_customer_consent_receipt(${tenant}::uuid, ${entity}::uuid, ${receiptId}::uuid, ${JSON.stringify(value)}::text)`;
    const read = (tenant = tenantId, entity = legalEntityId) =>
      runtime<{
        receipt: unknown;
      }>`select * from commerce_customer_context.read_customer_consent_receipt(${tenant}::uuid, ${entity}::uuid, ${receiptId}::uuid)`;
    expect(yield* scoped(read())).toEqual([]);
    expect(yield* scoped(write())).toEqual([{ receipt }]);
    expect(yield* scoped(write())).toEqual([{ receipt }]);
    // The native routine never overwrites a receipt, including after an ambiguous outcome/retry.
    expect(
      yield* scoped(write({ ...receipt, acknowledgedAt: '2026-10-23T13:00:00.000Z', decision: 'WITHDRAWN' })),
    ).toEqual([{ receipt }]);
    expect(yield* scoped(read())).toEqual([{ receipt }]);
    expect(yield* scoped(read(anotherTenant), anotherTenant)).toEqual([]);
    expect(yield* scoped(read(tenantId, anotherEntity), tenantId, anotherEntity)).toEqual([]);
    // Even matching arguments cannot smuggle a different subject tenant/controller into the journal.
    for (const scope of [
      { ...receipt.scope, controllerRef: anotherEntity },
      { ...receipt.scope, privacySubjectRef: { ...receipt.scope.privacySubjectRef, tenantId: anotherTenant } },
    ]) {
      const rejected = yield* scoped(write({ ...receipt, scope })).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Option.getOrUndefined(findPostgresFailure(rejected.failure))?.code).toBe('42501');
      }
    }
    for (const query of [read(anotherTenant), read(tenantId, anotherEntity), write(receipt, anotherTenant)]) {
      const rejected = yield* scoped(query).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Option.getOrUndefined(findPostgresFailure(rejected.failure))?.code).toBe('42501');
      }
    }
    const rawRead = yield* scoped(runtime`select * from commerce_customer_context.customer_consent_receipts`).pipe(
      Effect.result,
    );
    expect(Result.isFailure(rawRead)).toBe(true);
    if (Result.isFailure(rawRead)) {
      expect(Option.getOrUndefined(findPostgresFailure(rawRead.failure))?.code).toBe('42501');
    }
    for (const mutation of [
      admin`update commerce_customer_context.customer_consent_receipts set receipt = receipt where receipt_id = ${receiptId}::uuid`,
      admin`delete from commerce_customer_context.customer_consent_receipts where receipt_id = ${receiptId}::uuid`,
    ]) {
      const rejected = yield* mutation.pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Option.getOrUndefined(findPostgresFailure(rejected.failure))?.code).toBe('55000');
      }
    }
    const security = yield* admin<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity from pg_class
      where oid = 'commerce_customer_context.customer_consent_receipts'::regclass`;
    expect(security).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
  }),
);
