import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  COMPOSITION_REVISION,
  expectSqlFailure,
  failureCodeOf,
  inScope,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  withPersistence,
} from './database-fixture.ts';

it.live('#1148 foreign Tenant or Selling Legal Entity never reads or mutates a Payment (forced RLS)', () =>
  Effect.scoped(
    Effect.gen(function* rlsIsolation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const otherTenant = yield* makeTestScope;
      const otherLegalEntity = { ...(yield* makeTestScope), principalId: scope.principalId, tenantId: scope.tenantId };
      const paymentInput = yield* newPaymentInput(scope);
      const created = yield* withPersistence(runtime, scope, (persistence) => persistence.insertPayment(paymentInput));
      const { paymentId } = created.record;

      for (const foreign of [otherTenant, otherLegalEntity]) {
        expect(
          yield* failureCodeOf(withPersistence(runtime, foreign, (persistence) => persistence.lockPayment(paymentId))),
        ).toBe('payment_not_found');
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, foreign, (persistence) => persistence.loadAggregate(paymentId)),
          ),
        ).toBe('payment_not_found');
        const visible = yield* inScope(
          runtimeClient,
          foreign,
          runtimeClient.unsafe<{ count: number }>(
            'select count(*)::integer as count from payment.payments where payment_id = $1',
            [paymentId],
          ),
        );
        expect(visible[0]?.count).toBe(0);
      }

      const own = yield* inScope(
        runtimeClient,
        scope,
        runtimeClient.unsafe<{ count: number }>(
          'select count(*)::integer as count from payment.payments where payment_id = $1',
          [paymentId],
        ),
      );
      expect(own[0]?.count).toBe(1);

      // No installed scope: the runtime role sees nothing at all.
      const unscoped = yield* runtimeClient
        .unsafe<{ count: number }>('select count(*)::integer as count from payment.payments where payment_id = $1', [
          paymentId,
        ])
        .pipe(runtimeClient.withTransaction);
      expect(unscoped[0]?.count).toBe(0);

      // Writing a row for another Tenant/SLE than the installed scope violates the RLS WITH CHECK policy.
      yield* expectSqlFailure(
        inScope(
          runtimeClient,
          otherLegalEntity,
          runtimeClient.unsafe(
            `insert into payment.payment_authorizations (tenant_id, legal_entity_id, action_invocation_id,
               actor_principal_id, composition_revision, amount_minor, coverage_revision, currency, expires_at,
               issuance_key, issued_at, method, order_commitment_attempt_id, payment_id, payment_term_ref, proof_kind,
               purchase_correlation_id)
             values ($1, $2, gen_random_uuid(), $3, $4, 100000, 1, 'CZK', now() + interval '5 minutes', 'issue-1', now(),
               'ONLINE_GATEWAY', 'attempt-1', $5, '{}'::jsonb, 'PREPAID_COVERAGE', 'purchase-1')`,
            [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, paymentId],
          ),
        ),
        '42501',
      );
    }),
  ),
);
