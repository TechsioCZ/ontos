import { Effect, Option } from 'effect';

import { paymentLifecycleConflict } from '../../shared/domain/lifecycle-conflict.ts';
import { paymentFundsSnapshotOf } from '../persistence/payment-aggregate-persistence.ts';
import type { PaymentAggregatePersistence } from '../persistence/payment-aggregate-persistence.ts';
import { decidePurchaseRelease } from './lifecycle-intent.ts';

/**
 * #1145/#1148 reconcile first: no new intent and no new COLLECT of a purchase while another intent of
 * the same purchase still carries a live, indeterminate, conflicting, held or unreturned effect. The
 * caller has already row-locked `purchasePaymentIds`, so the decision is taken on Current state.
 */
export const requireReleasedPurchase = Effect.fn('PaymentLifecycle.requireReleasedPurchase')(
  function* requireReleasedPurchase(
    purchasePaymentIds: readonly string[],
    aggregate: PaymentAggregatePersistence,
    exceptPaymentId?: string,
  ) {
    const siblings = yield* Effect.forEach(
      purchasePaymentIds.filter((paymentId) => paymentId !== exceptPaymentId),
      (paymentId) =>
        aggregate.loadAggregate(paymentId).pipe(
          Effect.map((record) => ({
            funds: paymentFundsSnapshotOf(record),
            operations: record.operations,
            paymentId,
          })),
        ),
      { concurrency: 1 },
    );
    return yield* Option.match(decidePurchaseRelease(siblings), {
      onNone: () => Effect.void,
      onSome: ({ reason }) =>
        Effect.fail(
          paymentLifecycleConflict(
            'payment_predecessor_unresolved_conflict',
            `Another Payment intent of this purchase still has an unresolved monetary effect (${reason}); reconcile it first`,
          ),
        ),
    });
  },
);
