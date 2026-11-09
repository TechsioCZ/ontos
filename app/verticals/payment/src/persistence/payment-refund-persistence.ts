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
import { observations, reconciliationDecisions, sourceAuthorities } from '../database/schema.ts';
import type { PaymentRefundRouteCandidate } from '../domain/refund-execution-route.ts';
import { correctionReachOf } from '../domain/refund-prior-returns.ts';
import type { PaymentReturnEvidence } from '../domain/refund-prior-returns.ts';

/**
 * Owner-local refund reads over the Core-installed `ScopedTransactionExecutor` (#1150/#1152). The
 * configured refund execution authorities are read with `FOR SHARE` inside the refund transaction,
 * so a concurrent revocation cannot interleave with admitting a refund under that authority. Lock
 * order matches source statement acceptance: the authority rows first, then the Payment row.
 */
export interface PaymentRefundPersistence {
  readonly selectRefundRouteCandidates: () => Effect.Effect<readonly PaymentRefundRouteCandidate[], PaymentUnavailable>;
  /** Qualified REFUND_CONFIRMED statements of the Payment, less accepted corrections; read under its row lock. */
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

interface ReturnStatementRow {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly economicEffectKey: string | null;
  readonly observationId: string;
  readonly operationId: string | null;
}

interface CorrectionRow {
  readonly amountMinor: number | null;
  readonly correctsObservationId: string | null;
  readonly currency: string | null;
}

/**
 * One statement as the refund guard reads it. A statement fully covered by its accepted corrections
 * is gone (undefined). A partially corrected statement keeps its stated money and the corrected part.
 * A statement held without an operation counts toward the operation its governed attachment resulted in.
 */
const returnEvidenceOf = Effect.fn('PaymentRefundPersistence.returnEvidenceOf')(function* returnEvidenceOf(
  row: ReturnStatementRow,
  corrections: readonly CorrectionRow[],
  attachedOperationId: string | undefined,
) {
  const stated = yield* storedAmountOf(row).pipe(
    Effect.mapError((cause) => paymentUnavailable('Stored return evidence money is unreadable', cause)),
  );
  const correctionAmounts = yield* Effect.forEach(
    corrections,
    (correction) =>
      storedAmountOf(correction).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => paymentUnavailable('Stored return evidence money is unreadable', cause)),
      ),
    { concurrency: 1 },
  );
  const reach = correctionReachOf(Option.getOrUndefined(stated), correctionAmounts);
  if (reach.covered) {
    return null;
  }
  return {
    amount: Option.getOrUndefined(stated),
    correctedAmount: reach.correctedAmount,
    economicEffectKey: row.economicEffectKey ?? undefined,
    observationId: row.observationId,
    operationId: row.operationId ?? attachedOperationId,
  } satisfies PaymentReturnEvidence;
});

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
  /**
   * The operation each governed-attached statement counts toward, derived the way the evidence reader
   * derives attachments (#1151): the attachment's resulting operation, else its case's operation. Only
   * attachments with a resulting outcome count, and the latest one wins.
   */
  const attachedOperationsOf = Effect.fn('PaymentRefundPersistence.attachedOperationsOf')(
    function* attachedOperationsOf(
      scope: { readonly legalEntityId: string; readonly tenantId: string },
      observationIds: readonly string[],
    ) {
      const attached = new Map<string, string>();
      if (observationIds.length === 0) {
        return attached;
      }
      const decisionRows = yield* transaction
        .select({
          evidenceRef: reconciliationDecisions.evidenceRef,
          operationId: reconciliationDecisions.operationId,
          resultingOutcome: reconciliationDecisions.resultingOutcome,
        })
        .from(reconciliationDecisions)
        .where(
          and(
            eq(reconciliationDecisions.tenantId, scope.tenantId),
            eq(reconciliationDecisions.legalEntityId, scope.legalEntityId),
            eq(reconciliationDecisions.decisionKind, 'ATTACH_EVIDENCE'),
            inArray(reconciliationDecisions.evidenceRef, [...observationIds]),
          ),
        )
        .orderBy(asc(reconciliationDecisions.decidedAt), asc(reconciliationDecisions.decisionId))
        .pipe(Effect.mapError(returnEvidenceReadFailure));
      for (const row of decisionRows) {
        if (row.evidenceRef !== null && row.resultingOutcome !== null && row.operationId !== null) {
          attached.set(row.evidenceRef, row.operationId);
        }
      }
      return attached;
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
            .select({
              amountMinor: observations.amountMinor,
              correctsObservationId: observations.correctsObservationId,
              currency: observations.currency,
            })
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
      const attached = yield* attachedOperationsOf(
        { legalEntityId, tenantId },
        statements.filter((row) => row.operationId === null).map((row) => row.observationId),
      );
      const evidence = yield* Effect.forEach(
        statements,
        (row) =>
          returnEvidenceOf(
            row,
            corrections.filter((correction) => correction.correctsObservationId === row.observationId),
            attached.get(row.observationId),
          ),
        { concurrency: 1 },
      );
      return evidence.flatMap((entry) => (entry === null ? [] : [entry]));
    },
  );
  return Object.freeze({ selectRefundRouteCandidates, selectReturnEvidence });
};
