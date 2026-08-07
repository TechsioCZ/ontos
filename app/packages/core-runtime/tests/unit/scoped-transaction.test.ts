/* eslint-disable require-await, unicorn/no-useless-undefined -- The minimal fake executor mirrors Drizzle's Promise surface. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  enableGovernedRls,
  installOperationalScope,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '../../src/db/scoped-transaction.ts';
import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';

test('installs and verifies transaction-local scope and exposes no transaction controls', async () => {
  let calls = 0;
  const transaction = {
    delete: () => undefined,
    execute: async () => {
      calls += 1;
      return calls === 1
        ? { rows: [] }
        : { rows: [{ legal_entity_id: 'entity', tenant_id: 'tenant' }] };
    },
    insert: () => undefined,
    query: {},
    select: () => undefined,
    update: () => undefined,
  };
  const capability = await Effect.runPromise(
    installOperationalScope(transaction as never, {
      authMethod: 'system',
      correlationId: 'c-1',
      legalEntityId: 'entity',
      principalId: 'principal',
      tenantId: 'tenant',
    }),
  );
  assert.equal(calls, 2);
  assert.equal('commit' in capability, false);
  assert.equal('rollback' in capability, false);
  assert.equal('transaction' in capability, false);
});

test('fails closed when transaction settings do not match', async () => {
  const transaction = {
    execute: async () => ({ rows: [{ legal_entity_id: '', tenant_id: 'foreign' }] }),
  };
  const error = await Effect.runPromise(
    Effect.flip(
      installOperationalScope(transaction as never, {
        authMethod: 'system',
        correlationId: 'c-1',
        principalId: 'principal',
        tenantId: 'tenant',
      }),
    ),
  );
  assert.equal(error._tag, 'OperationContextUnavailable');
});

test('creates complete CRUD RLS policies with update using and with-check predicates', () => {
  const fixture = enableGovernedRls(
    pgTable('fixture', {
      legalEntityId: uuid('legal_entity_id').notNull(),
      tenantId: uuid('tenant_id').notNull(),
    }),
  );
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
