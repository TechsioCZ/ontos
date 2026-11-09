import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentObservationAcceptanceOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  PaymentMethodSchema,
  PaymentSourceAuthorityStatusSchema,
  PaymentSourceFactFamilySchema,
  PaymentSourceKindSchema,
} from '../../shared/domain/payment-vocabulary.ts';
import { observations, sourceAuthorities } from '../database/schema.ts';
import type { PaymentRefundRouteCandidate } from '../domain/refund-execution-route.ts';
import type { PaymentReturnEvidence } from '../domain/refund-prior-returns.ts';

/**
 * Owner-local refund reads over the Core-installed `ScopedTransactionExecutor` (#1150/#1152). The
 * configured refund execution authorities are read with `FOR SHARE` inside the refund transaction,
 * so a concurrent revocation cannot interleave with admitting a refund under that authority. Lock
 * order matches source statement acceptance: the authority rows first, then the Payment row.
 */
export interface PaymentRefundPersistence {
  readonly selectRefundRouteCandidates: () => Effect.Effect<readonly PaymentRefundRouteCandidate[], PaymentUnavailable>;
  /** Qualified, uncorrected REFUND_CONFIRMED statements of the Payment; read under its row lock. */
  readonly selectReturnEvidence: (
    paymentId: string,
  ) => Effect.Effect<readonly PaymentReturnEvidence[], PaymentUnavailable>;
}

/** Recorded, authorized statements; duplicates, unauthorized and unsupported facts prove nothing. */
const QUALIFIED_ACCEPTANCE: readonly PaymentObservationAcceptanceOutcome[] = [
  'ACCEPTED_OBSERVATION',
  'HELD_UNRESOLVED',
  'CONFLICT',
];

const StoredCandidateSchema = Schema.Struct({
  factFamily: PaymentSourceFactFamilySchema,
  method: Schema.OptionFromNullOr(PaymentMethodSchema),
  sourceKind: PaymentSourceKindSchema,
  status: PaymentSourceAuthorityStatusSchema,
});
const decodeStoredCandidate = Schema.decodeUnknownEffect(StoredCandidateSchema);
const decodeStoredAmount = Schema.decodeUnknownEffect(PaymentMonetaryAmountSchema);

/** The measured amount of a statement; a statement without money stays unmeasured. */
const storedAmountOf = (row: {
  readonly amountMinor: number | null;
  readonly currency: string | null;
}): Effect.Effect<Option.Option<PaymentMonetaryAmount>, Schema.SchemaError> =>
  row.amountMinor === null || row.currency === null
    ? Effect.succeedNone
    : decodeStoredAmount({ amountMinor: row.amountMinor, currency: row.currency }).pipe(Effect.map(Option.some));

const returnEvidenceReadFailure = (cause: unknown) =>
  paymentUnavailable('Prior return evidence could not be read', cause);

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
  const selectReturnEvidence = Effect.fn('PaymentRefundPersistence.selectReturnEvidence')(
    function* selectReturnEvidence(paymentId: string) {
      const { legalEntityId, tenantId } = transaction.scope;
      if (legalEntityId === undefined) {
        return yield* paymentUnavailable('A verified Selling Legal Entity scope is required');
      }
      const ofPayment = and(
        eq(observations.tenantId, tenantId),
        eq(observations.legalEntityId, legalEntityId),
        eq(observations.paymentId, paymentId),
      );
      const [statements, corrections] = yield* Effect.all(
        [
          transaction
            .select({
              amountMinor: observations.amountMinor,
              currency: observations.currency,
              economicEffectKey: observations.economicEffectKey,
              observationId: observations.observationId,
              operationId: observations.operationId,
            })
            .from(observations)
            .where(
              and(
                ofPayment,
                eq(observations.factKind, 'REFUND_CONFIRMED'),
                inArray(observations.acceptanceOutcome, [...QUALIFIED_ACCEPTANCE]),
              ),
            )
            .orderBy(asc(observations.observationId))
            .pipe(Effect.mapError(returnEvidenceReadFailure)),
          transaction
            .select({ correctsObservationId: observations.correctsObservationId })
            .from(observations)
            .where(
              and(
                ofPayment,
                eq(observations.factKind, 'SOURCE_CORRECTION'),
                eq(observations.acceptanceOutcome, 'ACCEPTED_OBSERVATION'),
                isNotNull(observations.correctsObservationId),
              ),
            )
            .pipe(Effect.mapError(returnEvidenceReadFailure)),
        ],
        { concurrency: 1 },
      );
      const corrected = new Set(corrections.map((row) => row.correctsObservationId));
      return yield* Effect.forEach(
        statements.filter((row) => !corrected.has(row.observationId)),
        (row) =>
          storedAmountOf(row).pipe(
            Effect.map((amount): PaymentReturnEvidence => ({
              amount: Option.getOrUndefined(amount),
              economicEffectKey: row.economicEffectKey ?? undefined,
              observationId: row.observationId,
              operationId: row.operationId ?? undefined,
            })),
            Effect.mapError((cause) => paymentUnavailable('Stored return evidence money is unreadable', cause)),
          ),
        { concurrency: 1 },
      );
    },
  );
  return Object.freeze({ selectRefundRouteCandidates, selectReturnEvidence });
};
