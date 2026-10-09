import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  OperationalScopeTransaction,
  installOperationalScopeFromTransactionService,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '../../src/db/scoped-transaction.ts';
import type { OperationalScopeTransactionService } from '../../src/db/scoped-transaction.ts';
import type { ScopedRoutineInvoker } from '../../src/db/scoped-routine.ts';

const unusedOperation = (): never => {
  throw new Error('CRUD operations are not used by this test');
};
const unusedRoutineInvoker = (): ScopedRoutineInvoker => ({ invoke: unusedOperation });
const transactionService = (
  install: OperationalScopeTransactionService['install'],
  verify: OperationalScopeTransactionService['verify'],
): OperationalScopeTransactionService => ({
  delete: unusedOperation,
  insert: unusedOperation,
  install,
  scopedRoutineInvoker: unusedRoutineInvoker,
  select: unusedOperation,
  update: unusedOperation,
  verify,
});
const principalId = '10000000-0000-4000-8000-000000000001';
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const transactionScope = (withLegalEntity: boolean) => {
  const context = withLegalEntity
    ? Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:scoped-transaction',
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      })
    : Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:scoped-transaction',
        authMethod: 'session',
        principalId,
        tenantId,
      });
  return { ...context, correlationId: 'c-1' };
};
it.effect('installs and verifies transaction-local scope and exposes no transaction controls', () =>
  Effect.gen(function* migratedTest1() {
    let calls = 0;
    const transaction = transactionService(
      () =>
        Effect.sync(() => {
          calls += 1;
        }),
      Effect.sync(() => {
        calls += 1;
        return Option.some({
          legal_entity_id: legalEntityId,
          tenant_id: tenantId,
        });
      }),
    );
    const capability = yield* installOperationalScopeFromTransactionService(transactionScope(true)).pipe(
      Effect.provideService(OperationalScopeTransaction, transaction),
    );
    expect(calls).toBe(2);
    expect('commit' in capability).toBe(false);
    expect('query' in capability).toBe(false);
    expect('rollback' in capability).toBe(false);
    expect('transaction' in capability).toBe(false);
    expect('invoke' in capability).toBe(true);
  }),
);
it.effect('fails closed when transaction settings do not match', () =>
  Effect.gen(function* migratedTest2() {
    const transaction = transactionService(
      () => Effect.void,
      Effect.succeedSome({ legal_entity_id: '', tenant_id: 'foreign' }),
    );
    const error = yield* Effect.flip(
      installOperationalScopeFromTransactionService(transactionScope(false)).pipe(
        Effect.provideService(OperationalScopeTransaction, transaction),
      ),
    );
    expect(Predicate.isTagged(error, 'OperationContextUnavailable')).toBe(true);
  }),
);
it('creates complete CRUD RLS policies with update using and with-check predicates', () => {
  const fixture = pgTable.withRLS('fixture', {
    legalEntityId: uuid('legal_entity_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  });
  expect(getTableConfig(fixture).enableRLS).toBe(true);
  for (const policies of [
    tenantRlsPolicies('tenant_fixture', fixture.tenantId),
    tenantLegalEntityRlsPolicies('entity_fixture', fixture.tenantId, fixture.legalEntityId),
  ]) {
    expect(policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(policies[2].using).toBeDefined();
    expect(policies[2].withCheck).toBeDefined();
  }
});
