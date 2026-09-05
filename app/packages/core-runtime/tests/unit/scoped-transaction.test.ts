// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
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
      calls += 1;
    },
    async () => {
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

void test('fails closed when transaction settings do not match', async () => {
  const transaction = transactionService(
    async () => {},
    async () => ({ legal_entity_id: '', tenant_id: 'foreign' }),
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
