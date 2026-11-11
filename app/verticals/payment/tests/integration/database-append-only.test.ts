import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  expectSqlFailure,
  inScope,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  provenanceFor,
  withPersistence,
} from './database-fixture.ts';

it.live('#1148/#1151 Payment meaning, outcome lineage and evidence ledgers are append-only in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* appendOnly() {
      const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const paymentInput = yield* newPaymentInput(scope);
      const created = yield* withPersistence(runtime, scope, (persistence) => persistence.insertPayment(paymentInput));
      const { paymentId } = created.record;
      const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
      const collected = yield* withPersistence(runtime, scope, (persistence) => persistence.insertOperation(collect));
      const confirm = yield* provenanceFor(scope);
      yield* withPersistence(runtime, scope, (persistence) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
          expectedOutcomeRevision: 1,
          operationId: collected.record.operationId,
          paymentId,
          provenance: confirm,
          to: 'EFFECT_CONFIRMED',
        }),
      );
      const runtimeSql = (statement: string) =>
        inScope(runtimeClient, scope, runtimeClient.unsafe(statement, [scope.tenantId]));
      const ownerSql = (statement: string) => inScope(admin, scope, admin.unsafe(statement, [scope.tenantId]));

      // The shared runtime role has no DELETE, no material UPDATE and no ledger UPDATE privilege.
      yield* expectSqlFailure(runtimeSql('delete from payment.payments where tenant_id = $1'), '42501');
      yield* expectSqlFailure(runtimeSql('update payment.payments set amount_minor = 1 where tenant_id = $1'), '42501');
      yield* expectSqlFailure(
        runtimeSql("update payment.operation_outcome_transitions set cause_id = 'rewritten' where tenant_id = $1"),
        '42501',
      );
      yield* expectSqlFailure(
        runtimeSql("update payment.payment_operations set operation_key = 'rewritten' where tenant_id = $1"),
        '42501',
      );

      // Even the owning migration identity cannot rewrite history: triggers reject it.
      yield* expectSqlFailure(
        ownerSql("update payment.operation_outcome_transitions set cause_id = 'rewritten' where tenant_id = $1"),
        '23514',
        'payment_append_only_ck',
      );
      yield* expectSqlFailure(
        ownerSql('delete from payment.operation_outcome_transitions where tenant_id = $1'),
        '23514',
        'payment_append_only_ck',
      );
      yield* expectSqlFailure(
        ownerSql('delete from payment.payments where tenant_id = $1'),
        '23514',
        'payment_append_only_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          'update payment.payments set amount_minor = 120000, aggregate_version = aggregate_version + 1 where tenant_id = $1',
        ),
        '23514',
        'payment_payment_transition_ck',
      );
      // #1148 Refund does not erase collection / stale PENDING cannot erase EFFECT_CONFIRMED.
      yield* expectSqlFailure(
        ownerSql(
          "update payment.payment_operations set outcome = 'PENDING', outcome_revision = outcome_revision + 1 where tenant_id = $1",
        ),
        '23514',
        'payment_operation_transition_ck',
      );
      yield* expectSqlFailure(
        ownerSql(
          "update payment.payment_operations set outcome = 'NOT_EFFECTED_CONFIRMED', outcome_revision = outcome_revision + 1 where tenant_id = $1",
        ),
        '23514',
        'payment_operation_transition_ck',
      );
      // An outcome change without its appended transition row is refused at commit.
      yield* expectSqlFailure(
        ownerSql(
          "update payment.payment_operations set outcome = 'CONFLICT', outcome_revision = outcome_revision + 1 where tenant_id = $1",
        ),
        '23514',
        'payment_operation_lineage_ck',
      );
      yield* expectSqlFailure(
        inScope(
          admin,
          scope,
          admin.unsafe(
            `insert into payment.payment_operations (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
               composition_revision, amount_minor, binding, created_at, currency, kind, material_hash, material_request,
               operation_key, outcome, outcome_revision, payment_id, target_operation_id)
             values ($1, $2, gen_random_uuid(), $3, $4, 0, '{"_tag":"BANK_ACCOUNTING_RECEIPT"}'::jsonb, now(), 'CZK',
               'CANCEL_OR_VOID', $5, '{}'::jsonb, 'cancel-without-lineage', 'PENDING', 1, $6, $7)`,
            [
              scope.tenantId,
              scope.legalEntityId,
              scope.principalId,
              COMPOSITION_REVISION,
              'e'.repeat(64),
              paymentId,
              collected.record.operationId,
            ],
          ),
        ),
        '23514',
        'payment_operation_lineage_ck',
      );

      const unchanged = yield* withPersistence(runtime, scope, (persistence) => persistence.loadAggregate(paymentId));
      expect(unchanged.payment.amount).toEqual({ amountMinor: 100_000, currency: 'CZK' });
      expect(unchanged.operations.map((operation) => operation.outcome)).toEqual(['EFFECT_CONFIRMED']);
    }),
  ),
);
