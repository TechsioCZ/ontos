import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { configuredRefundExecutionRouteFor } from '../support/refund-execution-route.fixture.ts';
import {
  collectInput,
  expectSqlFailure,
  inScope,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  provenanceFor,
  withPersistence,
} from './database-fixture.ts';

/**
 * A REFUND is evidenced and recovered only against the configured executor it was requested through
 * (#1150/#1152), so PostgreSQL itself refuses a REFUND row without its execution route and any other
 * operation that claims one, whatever writes it.
 */
it.live('#1150 #1152 Every REFUND row stores its execution route and no other operation has one', () =>
  Effect.scoped(
    Effect.gen(function* refundRouteRequired() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const paymentInput = yield* newPaymentInput(scope);
      const created = yield* withPersistence(runtime, scope, (persistence) => persistence.insertPayment(paymentInput));
      const { paymentId } = created.record;
      const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
      const collected = yield* withPersistence(runtime, scope, (persistence) => persistence.insertOperation(collect));
      const [confirmProvenance, refundProvenance, refundExecutionRoute] = yield* Effect.all(
        [
          provenanceFor(scope),
          provenanceFor(scope),
          configuredRefundExecutionRouteFor(runtime, scope, paymentInput.executionBinding),
        ],
        { concurrency: 1 },
      );
      yield* withPersistence(runtime, scope, (persistence) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
          expectedOutcomeRevision: 1,
          operationId: collected.record.operationId,
          paymentId,
          provenance: confirmProvenance,
          to: 'EFFECT_CONFIRMED',
        }),
      );
      const refund = yield* withPersistence(runtime, scope, (persistence) =>
        persistence.insertOperation({
          amount: { amountMinor: 40_000, currency: 'CZK' },
          binding: paymentInput.executionBinding,
          initialOutcome: 'PENDING',
          kind: 'REFUND',
          materialRequest: { itemRefs: ['A'], kind: 'REFUND', operationKey: 'refund-1' },
          operationKey: 'refund-1',
          paymentId,
          provenance: refundProvenance,
          refundBasis: {
            _tag: 'REFUNDABLE_ITEMS',
            items: [{ amountMinor: 40_000, currency: 'CZK', itemRef: 'A', sourceEvidenceRef: 'order:item:A' }],
          },
          refundExecutionRoute,
          targetOperationId: collected.record.operationId,
        }),
      );
      expect(refund.record.refundExecutionRoute).toEqual(refundExecutionRoute);
      expect(collected.record.refundExecutionRoute).toBeUndefined();

      /** A copy of a stored operation under a new key, with the given execution route. */
      const copyOf = (operationId: string, operationKey: string, route: string) =>
        inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe(
            `insert into payment.payment_operations (tenant_id, legal_entity_id, action_invocation_id,
               actor_principal_id, composition_revision, amount_minor, binding, created_at, currency, kind,
               material_hash, material_request, operation_key, outcome, outcome_revision, payment_id, refund_basis,
               refund_basis_kind, refund_execution_route, target_operation_id)
             select tenant_id, legal_entity_id, gen_random_uuid(), actor_principal_id, composition_revision,
               amount_minor, binding, created_at, currency, kind, material_hash, material_request, $2, outcome,
               outcome_revision, payment_id, refund_basis, refund_basis_kind, ${route}, target_operation_id
             from payment.payment_operations where operation_id = $1`,
            [operationId, operationKey],
          ),
        );
      // A REFUND that does not keep the executor it was requested through.
      yield* expectSqlFailure(
        copyOf(refund.record.operationId, 'refund-without-route', 'null'),
        '23514',
        'payment_operations_refund_route_ck',
      );
      // A route that is not an object is no execution route either.
      yield* expectSqlFailure(
        copyOf(refund.record.operationId, 'refund-with-scalar-route', `'"BANK_ACCOUNTING"'::jsonb`),
        '23514',
        'payment_operations_refund_route_ck',
      );
      // A COLLECT never carries a refund execution route.
      yield* expectSqlFailure(
        copyOf(
          collected.record.operationId,
          'collect-with-route',
          `(select requested.refund_execution_route from payment.payment_operations requested
             where requested.payment_id = payment_operations.payment_id and requested.kind = 'REFUND')`,
        ),
        '23514',
        'payment_operations_refund_route_ck',
      );
      // With the route it was requested through, the copy passes every check and only meets the key.
      yield* expectSqlFailure(
        copyOf(refund.record.operationId, 'refund-1', 'refund_execution_route'),
        '23505',
        'payment_operations_key_uk',
      );
    }),
  ),
);
