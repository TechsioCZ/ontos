import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { paymentWriteFailure } from '../../src/persistence/payment-aggregate-persistence.ts';
import type { NewPaymentOperationInput } from '../../src/persistence/payment-aggregate-persistence.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  expectSqlFailure,
  failureCodeOf,
  inScope,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  provenanceFor,
  withPersistence,
} from './database-fixture.ts';

it.live(
  '#1148 one live-or-proven COLLECT lineage: replay, material conflict, lineage conflict and the unique backstop',
  () =>
    Effect.scoped(
      Effect.gen(function* collectLineage() {
        const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
        const scope = yield* makeTestScope;
        const paymentInput = yield* newPaymentInput(scope);

        const created = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertPayment(paymentInput),
        );
        expect(created.written).toBe(true);
        expect(created.record.coverageRevision).toBe(1);
        const { paymentId } = created.record;
        const payment = { amountMinor: paymentInput.amount.amountMinor, paymentId };

        // #1148 A new Core invocation recovers the same business intent: same key + material = same Payment.
        const replayProvenance = yield* provenanceFor(scope);
        const replayed = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertPayment({ ...paymentInput, provenance: replayProvenance }),
        );
        expect(replayed.written).toBe(false);
        expect(replayed.record.paymentId).toBe(paymentId);
        expect(replayed.record.provenance.actionInvocationId).toBe(paymentInput.provenance.actionInvocationId);

        // #1148 Changing amount: the original Payment is never mutated to 1200 CZK under the same intent.
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, scope, (persistence) =>
              persistence.insertPayment({ ...paymentInput, amount: { amountMinor: 120_000, currency: 'CZK' } }),
            ),
          ),
        ).toBe('payment_intent_material_conflict');

        const firstInput = yield* collectInput(scope, payment, 'collect-1');
        const first = yield* withPersistence(runtime, scope, (persistence) => persistence.insertOperation(firstInput));
        expect(first.written).toBe(true);
        expect(first.record.outcome).toBe('PENDING');

        // #1148 Retrying a collection: the same logical operation identity is returned.
        const retriedInput = yield* collectInput(scope, payment, 'collect-1');
        const retried = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertOperation(retriedInput),
        );
        expect(retried.written).toBe(false);
        expect(retried.record.operationId).toBe(first.record.operationId);

        const mutated: NewPaymentOperationInput = {
          ...retriedInput,
          materialRequest: { amountMinor: 1, currency: 'CZK', kind: 'COLLECT' },
        };
        expect(
          yield* failureCodeOf(withPersistence(runtime, scope, (persistence) => persistence.insertOperation(mutated))),
        ).toBe('payment_operation_material_conflict');

        // #1151 a second COLLECT identity while one is PENDING is a Payment-level conflict.
        const competingInput = yield* collectInput(scope, payment, 'collect-2');
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, scope, (persistence) => persistence.insertOperation(competingInput)),
          ),
        ).toBe('payment_collect_lineage_conflict');

        // The partial unique index refuses a competing live COLLECT even when owner code is bypassed.
        const rawCompetingCollect = inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe(
            `insert into payment.payment_operations (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
             composition_revision, amount_minor, binding, created_at, currency, kind, material_hash, material_request,
             operation_key, outcome, outcome_revision, payment_id)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, '{"_tag":"BANK_ACCOUNTING_RECEIPT"}'::jsonb, now(), 'CZK',
             'COLLECT', $6, '{}'::jsonb, 'raw-collect', 'PENDING', 1, $7)`,
            [
              scope.tenantId,
              scope.legalEntityId,
              scope.principalId,
              COMPOSITION_REVISION,
              String(payment.amountMinor),
              'd'.repeat(64),
              paymentId,
            ],
          ),
        );
        yield* expectSqlFailure(rawCompetingCollect, '23505', 'payment_operations_one_collect_lineage_uk');
        const mapped = paymentWriteFailure(yield* Effect.flip(rawCompetingCollect));
        expect(mapped.code).toBe('payment_collect_lineage_conflict');

        // #1151 genuine NOT_EFFECTED_CONFIRMED allows a new COLLECT for the unchanged meaning.
        const notEffectedProvenance = yield* provenanceFor(scope);
        const notEffected = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.transitionOperationOutcome({
            causedBy: { kind: 'OBSERVATION', sourceId: 'observation:declined' },
            expectedOutcomeRevision: 1,
            operationId: first.record.operationId,
            paymentId,
            provenance: notEffectedProvenance,
            to: 'NOT_EFFECTED_CONFIRMED',
          }),
        );
        expect(notEffected.written).toBe(true);
        expect(notEffected.record.outcomeRevision).toBe(2);
        const recollect = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertOperation(competingInput),
        );
        expect(recollect.written).toBe(true);

        const confirmedProvenance = yield* provenanceFor(scope);
        yield* withPersistence(runtime, scope, (persistence) =>
          persistence.transitionOperationOutcome({
            causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
            expectedOutcomeRevision: 1,
            operationId: recollect.record.operationId,
            paymentId,
            provenance: confirmedProvenance,
            to: 'EFFECT_CONFIRMED',
          }),
        );

        // #1151 any new COLLECT after confirmed collection returns CONFLICT.
        const afterConfirmedInput = yield* collectInput(scope, payment, 'collect-3');
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, scope, (persistence) => persistence.insertOperation(afterConfirmedInput)),
          ),
        ).toBe('payment_collect_lineage_conflict');

        // #1151 stale PENDING never overrides EFFECT_CONFIRMED.
        const staleProvenance = yield* provenanceFor(scope);
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, scope, (persistence) =>
              persistence.transitionOperationOutcome({
                causedBy: { kind: 'OBSERVATION', sourceId: 'observation:stale' },
                expectedOutcomeRevision: 2,
                operationId: recollect.record.operationId,
                paymentId,
                provenance: staleProvenance,
                to: 'PENDING',
              }),
            ),
          ),
        ).toBe('payment_outcome_transition_illegal');

        const aggregate = yield* withPersistence(runtime, scope, (persistence) => persistence.loadAggregate(paymentId));
        expect(aggregate.operations.map((operation) => [operation.operationKey, operation.outcome])).toEqual([
          ['collect-1', 'NOT_EFFECTED_CONFIRMED'],
          ['collect-2', 'EFFECT_CONFIRMED'],
        ]);
        // Two outcome changes each advanced coverage; creating COLLECTs did not.
        expect(aggregate.payment.coverageRevision).toBe(3);
        expect(aggregate.payment.aggregateVersion).toBe(5);

        const lineage = yield* inScope(
          admin,
          scope,
          admin.unsafe<{ cause_kind: string; from_outcome: string | null; to_outcome: string }>(
            `select cause_kind, from_outcome, to_outcome from payment.operation_outcome_transitions
           where tenant_id = $1 and operation_id = $2 order by outcome_revision`,
            [scope.tenantId, first.record.operationId],
          ),
        );
        expect(lineage.map((row) => [row.cause_kind, row.from_outcome, row.to_outcome])).toEqual([
          ['CREATION', null, 'PENDING'],
          ['OBSERVATION', 'PENDING', 'NOT_EFFECTED_CONFIRMED'],
        ]);
      }),
    ),
);

it.live(
  '#1150 Two concurrent refunds overlap: an active item claim blocks another refund until definitive non-execution',
  () =>
    Effect.scoped(
      Effect.gen(function* refundItemClaims() {
        const { runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
        const scope = yield* makeTestScope;
        const paymentInput = yield* newPaymentInput(scope);
        const created = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertPayment(paymentInput),
        );
        const { paymentId } = created.record;
        const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
        const collected = yield* withPersistence(runtime, scope, (persistence) => persistence.insertOperation(collect));
        const confirmProvenance = yield* provenanceFor(scope);
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
        const refundOf = (operationKey: string) =>
          provenanceFor(scope).pipe(
            Effect.map((provenance): NewPaymentOperationInput => ({
              amount: { amountMinor: 50_000, currency: 'CZK' },
              binding: paymentInput.executionBinding,
              initialOutcome: 'PENDING',
              kind: 'REFUND',
              materialRequest: { itemRefs: ['B'], kind: 'REFUND', operationKey },
              operationKey,
              paymentId,
              provenance,
              refundBasis: {
                _tag: 'REFUNDABLE_ITEMS',
                items: [{ amountMinor: 50_000, currency: 'CZK', itemRef: 'B', sourceEvidenceRef: 'order:item:B' }],
              },
              targetOperationId: collected.record.operationId,
            })),
          );

        const firstRefundInput = yield* refundOf('refund-1');
        const firstRefund = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertOperation(firstRefundInput),
        );
        expect(firstRefund.written).toBe(true);
        const reserved = yield* withPersistence(runtime, scope, (persistence) => persistence.loadAggregate(paymentId));
        expect(reserved.activeClaims.map((claim) => claim.itemRef)).toEqual(['B']);
        // Starting a refund is coverage-affecting (#1149/#1150).
        expect(reserved.payment.coverageRevision).toBe(3);

        // #1150 a new key cannot evade the reservation of item B.
        const secondRefundInput = yield* refundOf('refund-2');
        expect(
          yield* failureCodeOf(
            withPersistence(runtime, scope, (persistence) => persistence.insertOperation(secondRefundInput)),
          ),
        ).toBe('payment_refund_item_reserved');

        // #1150 definitive non-execution releases the reservation atomically.
        const releaseProvenance = yield* provenanceFor(scope);
        yield* withPersistence(runtime, scope, (persistence) =>
          persistence.transitionOperationOutcome({
            causedBy: { kind: 'OBSERVATION', sourceId: 'observation:refund-failed' },
            expectedOutcomeRevision: 1,
            operationId: firstRefund.record.operationId,
            paymentId,
            provenance: releaseProvenance,
            to: 'NOT_EFFECTED_CONFIRMED',
          }),
        );
        const released = yield* withPersistence(runtime, scope, (persistence) => persistence.loadAggregate(paymentId));
        expect(released.activeClaims).toEqual([]);
        const retried = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertOperation(secondRefundInput),
        );
        expect(retried.written).toBe(true);
      }),
    ),
);
