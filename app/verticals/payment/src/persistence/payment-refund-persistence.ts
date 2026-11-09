import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import {
  PaymentMethodSchema,
  PaymentSourceAuthorityStatusSchema,
  PaymentSourceFactFamilySchema,
  PaymentSourceKindSchema,
} from '../../shared/domain/payment-vocabulary.ts';
import { sourceAuthorities } from '../database/schema.ts';
import type { PaymentRefundRouteCandidate } from '../domain/refund-execution-route.ts';

/**
 * Owner-local refund reads over the Core-installed `ScopedTransactionExecutor` (#1150/#1152). The
 * configured refund execution authorities are read with `FOR SHARE` inside the refund transaction,
 * so a concurrent revocation cannot interleave with admitting a refund under that authority.
 */
export interface PaymentRefundPersistence {
  readonly selectRefundRouteCandidates: () => Effect.Effect<readonly PaymentRefundRouteCandidate[], PaymentUnavailable>;
}

const StoredCandidateSchema = Schema.Struct({
  factFamily: PaymentSourceFactFamilySchema,
  method: Schema.OptionFromNullOr(PaymentMethodSchema),
  sourceKind: PaymentSourceKindSchema,
  status: PaymentSourceAuthorityStatusSchema,
});
const decodeStoredCandidate = Schema.decodeUnknownEffect(StoredCandidateSchema);

export const paymentRefundPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentRefundPersistence => {
  const selectRefundRouteCandidates = Effect.fn('PaymentRefundPersistence.selectRefundRouteCandidates')(
    function* selectRefundRouteCandidates() {
      const { legalEntityId, tenantId } = transaction.scope;
      if (legalEntityId === undefined) {
        return yield* paymentUnavailable('A verified Selling Legal Entity scope is required');
      }
      const rows = yield* transaction
        .select()
        .from(sourceAuthorities)
        .where(
          and(
            eq(sourceAuthorities.tenantId, tenantId),
            eq(sourceAuthorities.legalEntityId, legalEntityId),
            eq(sourceAuthorities.factFamily, 'REFUND_EXECUTION'),
          ),
        )
        .orderBy(asc(sourceAuthorities.sourceAuthorityId))
        .for('share')
        .pipe(Effect.mapError((cause) => paymentUnavailable('Refund execution routes could not be read', cause)));
      return yield* Effect.forEach(
        rows,
        (row) =>
          decodeStoredCandidate({
            factFamily: row.factFamily,
            method: row.method,
            sourceKind: row.sourceKind,
            status: row.status,
          }).pipe(
            Effect.map((decoded): PaymentRefundRouteCandidate => ({
              accountRef: row.accountRef,
              environment: row.environment,
              factFamily: decoded.factFamily,
              method: decoded.method,
              refundRoute: row.refundRoute,
              revision: row.revision,
              sourceAuthorityId: row.sourceAuthorityId,
              sourceKind: decoded.sourceKind,
              sourceSystem: row.sourceSystem,
              status: decoded.status,
            })),
            Effect.mapError((cause) => paymentUnavailable('A stored refund execution route is unreadable', cause)),
          ),
        { concurrency: 1 },
      );
    },
  );
  return Object.freeze({ selectRefundRouteCandidates });
};
