import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, exists, inArray, ne, or } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { observations, paymentOperations, payments } from '../database/schema.ts';
import type { PaymentAggregatePersistence } from './payment-aggregate-persistence.ts';
import type { PaymentApplicabilityPersistence } from './payment-applicability-persistence.ts';
import type { PaymentRefundPersistence } from './payment-refund-persistence.ts';

/**
 * Lifecycle-lane lookups over the Core-installed scoped transaction (#1148). Every query is bound to
 * the trusted Tenant + Selling Legal Entity scope; a foreign intent key or Payment is simply absent.
 */
export interface PaymentLifecyclePersistence {
  /** The Payment an intent key already identifies, locked so a concurrent replay serializes on it. */
  readonly findPaymentIdByIntentKey: (intentKey: string) => Effect.Effect<Option.Option<string>, PaymentUnavailable>;
  /** The purchase correlation an existing Payment belongs to (immutable, so read without a lock). */
  readonly findPurchaseCorrelationId: (paymentId: string) => Effect.Effect<Option.Option<string>, PaymentUnavailable>;
  /** The successor intent that replaced this Payment, if any (oldest first; at most one is admitted). */
  readonly findSuccessorPaymentId: (paymentId: string) => Effect.Effect<Option.Option<string>, PaymentUnavailable>;
  /** Candidates for a read of funds inconsistency; only the shared funds calculator can establish the hold. */
  readonly listFundsConsistencyCandidateIds: (
    paymentId: string | undefined,
    limit: number,
  ) => Effect.Effect<readonly string[], PaymentUnavailable>;
  /**
   * Every Payment of one purchase correlation, row-locked in Payment id order. Creating an intent and
   * starting a COLLECT both take these locks first, so competing intents of one purchase serialize.
   */
  readonly lockPurchasePaymentIds: (
    purchaseCorrelationId: string,
  ) => Effect.Effect<readonly string[], PaymentUnavailable>;
}

/** Services of the lifecycle Actions and the Current Payment Read, built by their private factories. */
export interface PaymentLifecycleServices {
  readonly aggregate: PaymentAggregatePersistence;
  /** Current merchant method enablement (#1147), read for the create-time applicability decision. */
  readonly applicability: PaymentApplicabilityPersistence;
  readonly lifecycle: PaymentLifecyclePersistence;
  /** The one funds snapshot builder (prior return evidence included) every reader shares. */
  readonly refunds: PaymentRefundPersistence;
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

  const findPurchaseCorrelationId = Effect.fn('PaymentLifecyclePersistence.findPurchaseCorrelationId')(
    function* findPurchaseCorrelationId(paymentId: string) {
      const scope = yield* ownerScope;
      const [row] = yield* transaction
        .select({ purchaseCorrelationId: payments.purchaseCorrelationId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            eq(payments.legalEntityId, scope.legalEntityId),
            eq(payments.paymentId, paymentId),
          ),
        )
        .pipe(Effect.mapError(readFailure));
      return Option.fromNullishOr(row?.purchaseCorrelationId);
    },
  );

  const listFundsConsistencyCandidateIds = Effect.fn('PaymentLifecyclePersistence.listFundsConsistencyCandidateIds')(
    function* listFundsConsistencyCandidateIds(paymentId: string | undefined, limit: number) {
      const scope = yield* ownerScope;
      // A standing return or a correction can invalidate the funds balance even without open rows.
      const standingRefund = exists(
        transaction
          .select({ operationId: paymentOperations.operationId })
          .from(paymentOperations)
          .where(
            and(
              eq(paymentOperations.tenantId, scope.tenantId),
              eq(paymentOperations.legalEntityId, scope.legalEntityId),
              eq(paymentOperations.paymentId, payments.paymentId),
              eq(paymentOperations.kind, 'REFUND'),
              ne(paymentOperations.outcome, 'NOT_EFFECTED_CONFIRMED'),
            ),
          ),
      );
      const returnOrCorrection = exists(
        transaction
          .select({ observationId: observations.observationId })
          .from(observations)
          .where(
            and(
              eq(observations.tenantId, scope.tenantId),
              eq(observations.legalEntityId, scope.legalEntityId),
              eq(observations.paymentId, payments.paymentId),
              inArray(observations.factKind, ['REFUND_CONFIRMED', 'SOURCE_CORRECTION']),
            ),
          ),
      );
      const rows = yield* transaction
        .select({ paymentId: payments.paymentId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            eq(payments.legalEntityId, scope.legalEntityId),
            paymentId === undefined ? undefined : eq(payments.paymentId, paymentId),
            or(standingRefund, returnOrCorrection),
          ),
        )
        .orderBy(asc(payments.paymentId))
        .limit(limit)
        .pipe(Effect.mapError(readFailure));
      return rows.map((row) => row.paymentId);
    },
  );

  const lockPurchasePaymentIds = Effect.fn('PaymentLifecyclePersistence.lockPurchasePaymentIds')(
    function* lockPurchasePaymentIds(purchaseCorrelationId: string) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select({ paymentId: payments.paymentId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            eq(payments.legalEntityId, scope.legalEntityId),
            eq(payments.purchaseCorrelationId, purchaseCorrelationId),
          ),
        )
        .orderBy(asc(payments.paymentId))
        .for('update')
        .pipe(Effect.mapError(readFailure));
      return rows.map((row) => row.paymentId);
    },
  );

  return Object.freeze({
    findPaymentIdByIntentKey,
    findPurchaseCorrelationId,
    findSuccessorPaymentId,
    listFundsConsistencyCandidateIds,
    lockPurchasePaymentIds,
  });
};
