import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { payments } from '../database/schema.ts';
import type { PaymentAggregatePersistence } from './payment-aggregate-persistence.ts';
import type { PaymentApplicabilityPersistence } from './payment-applicability-persistence.ts';

/**
 * Lifecycle-lane lookups over the Core-installed scoped transaction (#1148). Every query is bound to
 * the trusted Tenant + Selling Legal Entity scope; a foreign intent key or Payment is simply absent.
 */
export interface PaymentLifecyclePersistence {
  /** The Payment an intent key already identifies, locked so a concurrent replay serializes on it. */
  readonly findPaymentIdByIntentKey: (intentKey: string) => Effect.Effect<Option.Option<string>, PaymentUnavailable>;
  /** The successor intent that replaced this Payment, if any (oldest first; at most one is admitted). */
  readonly findSuccessorPaymentId: (paymentId: string) => Effect.Effect<Option.Option<string>, PaymentUnavailable>;
}

/** Services of the lifecycle Actions and the Current Payment Read, built by their private factories. */
export interface PaymentLifecycleServices {
  readonly aggregate: PaymentAggregatePersistence;
  /** Current merchant method enablement (#1147), read for the create-time applicability decision. */
  readonly applicability: PaymentApplicabilityPersistence;
  readonly lifecycle: PaymentLifecyclePersistence;
}

const readFailure = (cause: unknown) => paymentUnavailable('Payment lifecycle state could not be read', cause);

export const paymentLifecyclePersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentLifecyclePersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const findPaymentIdByIntentKey = Effect.fn('PaymentLifecyclePersistence.findPaymentIdByIntentKey')(
    function* findPaymentIdByIntentKey(intentKey: string) {
      const scope = yield* ownerScope;
      const [row] = yield* transaction
        .select({ paymentId: payments.paymentId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            eq(payments.legalEntityId, scope.legalEntityId),
            eq(payments.intentKey, intentKey),
          ),
        )
        .for('update')
        .pipe(Effect.mapError(readFailure));
      return Option.fromNullishOr(row?.paymentId);
    },
  );

  const findSuccessorPaymentId = Effect.fn('PaymentLifecyclePersistence.findSuccessorPaymentId')(
    function* findSuccessorPaymentId(paymentId: string) {
      const scope = yield* ownerScope;
      const [row] = yield* transaction
        .select({ paymentId: payments.paymentId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            eq(payments.legalEntityId, scope.legalEntityId),
            eq(payments.predecessorPaymentId, paymentId),
          ),
        )
        .orderBy(asc(payments.createdAt), asc(payments.paymentId))
        .limit(1)
        .pipe(Effect.mapError(readFailure));
      return Option.fromNullishOr(row?.paymentId);
    },
  );

  return Object.freeze({ findPaymentIdByIntentKey, findSuccessorPaymentId });
};
