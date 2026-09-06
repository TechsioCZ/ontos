// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { Cause, Effect, Option, Result, Schema } from 'effect';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import {
  getOperationContextUnavailableCause,
  installOperationalScopeFromTransactionService,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '../../src/db/scoped-transaction.ts';
import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import type { OperationalScopeTransactionService } from '../../src/db/scoped-transaction.ts';

const unusedOperation = (): never => {
  throw new Error('CRUD operations are not used by this test');
};
const transactionService = (
  install: OperationalScopeTransactionService['install'],
  verify: OperationalScopeTransactionService['verify'],
): OperationalScopeTransactionService => ({
  delete: unusedOperation,
  insert: unusedOperation,
  install,
  select: unusedOperation,
  update: unusedOperation,
  verify,
});

void test('installs and verifies transaction-local scope and exposes no transaction controls', async () => {
  let calls = 0;
  const transaction = transactionService(
    async () => {
      await Promise.resolve();
      calls += 1;
    },
    async () => {
      assert.equal(calls, 1);
      calls += 1;
      return { legal_entity_id: 'entity', tenant_id: 'tenant' };
    },
  );
  const capability = await Effect.runPromise(
    installOperationalScopeFromTransactionService(transaction, {
      authContextRef: 'job:test:run:scoped-transaction',
      authMethod: 'system',
      correlationId: 'c-1',
      legalEntityId: 'entity',
      principalId: 'principal',
      tenantId: 'tenant',
    }),
  );
  assert.equal(calls, 2);
  assert.equal('commit' in capability, false);
  assert.equal('query' in capability, false);
  assert.equal('rollback' in capability, false);
  assert.equal('transaction' in capability, false);
});

void test('maps install rejection to a sanitized unavailable error and preserves its cause', async () => {
  const installFailure = new Error('install driver failure');
  let verifyCalls = 0;
  const transaction = transactionService(
    async () => {
      throw installFailure;
    },
    async () => {
      verifyCalls += 1;
      return { legal_entity_id: '', tenant_id: '' };
    },
  );
  const error = await Effect.runPromise(
    Effect.flip(
      installOperationalScopeFromTransactionService(transaction, {
        authContextRef: 'job:test:run:scoped-transaction',
        authMethod: 'system',
        correlationId: 'c-1',
        principalId: 'principal',
        tenantId: 'tenant',
      }),
    ),
  );
  assert.equal(error._tag, 'OperationContextUnavailable');
  assert.equal(error.reason, 'The database operation scope could not be installed');
  const cause = getOperationContextUnavailableCause(error);
  assert.ok(cause);
  const defect = Option.getOrThrow(Result.getSuccess(Cause.findDie(cause)));
  assert.equal(defect.defect, installFailure);
  assert.equal(verifyCalls, 0);
  assert.deepEqual(Object.keys(error), ['_tag', 'code', 'reason']);
});

void test('maps verify rejection to a sanitized unavailable error and preserves its cause', async () => {
  const verifyFailure = new Error('verify driver failure');
  let installCalls = 0;
  const transaction = transactionService(
    async () => {
      installCalls += 1;
    },
    async () => {
      throw verifyFailure;
    },
  );
  const error = await Effect.runPromise(
    Effect.flip(
      installOperationalScopeFromTransactionService(transaction, {
        authContextRef: 'job:test:run:scoped-transaction',
        authMethod: 'system',
        correlationId: 'c-1',
        principalId: 'principal',
        tenantId: 'tenant',
      }),
    ),
  );
  assert.equal(error._tag, 'OperationContextUnavailable');
  assert.equal(error.reason, 'The database operation scope could not be verified');
  const cause = getOperationContextUnavailableCause(error);
  assert.ok(cause);
  const defect = Option.getOrThrow(Result.getSuccess(Cause.findDie(cause)));
  assert.equal(defect.defect, verifyFailure);
  assert.equal(installCalls, 1);
  assert.deepEqual(Object.keys(error), ['_tag', 'code', 'reason']);
});

void test('maps scope mismatch to a typed unavailable error after sequential validation', async () => {
  let calls = 0;
  const transaction = transactionService(
    async () => {
      calls += 1;
    },
    async () => {
      calls += 1;
      return { legal_entity_id: '', tenant_id: 'foreign' };
    },
  );
  const error = await Effect.runPromise(
    Effect.flip(
      installOperationalScopeFromTransactionService(transaction, {
        authContextRef: 'job:test:run:scoped-transaction',
        authMethod: 'system',
        correlationId: 'c-1',
        principalId: 'principal',
        tenantId: 'tenant',
      }),
    ),
  );
  assert.equal(error._tag, 'OperationContextUnavailable');
  assert.equal(error.reason, 'The database operation scope does not match the requested scope');
  assert.equal(getOperationContextUnavailableCause(error), undefined);
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(error), ['_tag', 'code', 'reason']);
});

void test('keeps instance diagnostics out of encoding, JSON and inspection', () => {
  const original = new Error('private-driver-secret');
  const error = OperationContextUnavailable.fromCause('Scope unavailable', original);
  const wire = {
    _tag: 'OperationContextUnavailable',
    code: 'operation_context_unavailable',
    reason: 'Scope unavailable',
  };
  assert.deepEqual(Schema.encodeSync(OperationContextUnavailable)(error), wire);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), wire);
  assert.doesNotMatch(inspect(error, { showHidden: true }), /private-driver-secret/);
  const decoded = Schema.decodeUnknownSync(OperationContextUnavailable)(wire);
  assert.equal(getOperationContextUnavailableCause(decoded), undefined);
  const cause = getOperationContextUnavailableCause(error);
  assert.ok(cause);
  assert.equal(Option.getOrThrow(Result.getSuccess(Cause.findDie(cause))).defect, original);
});

void test('creates complete CRUD RLS policies with update using and with-check predicates', () => {
  const fixture = pgTable.withRLS('fixture', {
    legalEntityId: uuid('legal_entity_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  });
  assert.equal(getTableConfig(fixture).enableRLS, true);
  for (const policies of [
    tenantRlsPolicies('tenant_fixture', fixture.tenantId),
    tenantLegalEntityRlsPolicies('entity_fixture', fixture.tenantId, fixture.legalEntityId),
  ]) {
    assert.deepEqual(
      policies.map((policy) => policy.for),
      ['select', 'insert', 'update', 'delete'],
    );
    assert.ok(policies[2].using);
    assert.ok(policies[2].withCheck);
  }
});
