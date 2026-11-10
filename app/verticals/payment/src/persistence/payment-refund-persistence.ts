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
import type { PaymentFundsSnapshot } from '../domain/coverage.ts';
import { correctionReachOf, fundsSnapshotWithPriorReturns } from '../domain/refund-prior-returns.ts';
import type { PaymentReturnEvidence } from '../domain/refund-prior-returns.ts';
import { paymentFundsSnapshotOf } from './payment-aggregate-persistence.ts';
import type { PaymentAggregateRecord } from './payment-aggregate-persistence.ts';
import { fullyDisprovenTargets } from './payment-full-disproof.ts';

/**
 * Owner-local refund reads over the Core-installed `ScopedTransactionExecutor` (#1150/#1152). The
 * configured refund execution authorities are read with `FOR SHARE` inside the refund transaction,
 * so a concurrent revocation cannot interleave with admitting a refund under that authority. Lock
 * order matches source statement acceptance: the authority rows first, then the Payment row.
 */
/** A loaded Payment's funds as every reader computes them: its prior return evidence and the completed snapshot. */
export interface PaymentFundsReadout {
  readonly evidence: readonly PaymentReturnEvidence[];
  readonly snapshot: PaymentFundsSnapshot;
}

export interface PaymentRefundPersistence {
  /**
   * The one funds snapshot every reader uses (#1150): the loaded aggregate plus its prior return evidence.
   * Coverage, proof issuance, proof validation and the refund guard all build it here, so they agree.
   * Call with the Payment row already locked (or in a read that takes no lock) and after that lock.
   */
  readonly selectFunds: (aggregate: PaymentAggregateRecord) => Effect.Effect<PaymentFundsReadout, PaymentUnavailable>;
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
  readonly accountRef: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly economicEffectKey: string | null;
  readonly environment: string;
  readonly observationId: string;
  readonly operationId: string | null;
  readonly sourceKind: string;
  readonly sourceSystem: string;
}

interface CorrectionRow {
  readonly amountMinor: number | null;
  readonly correctsObservationId: string | null;
  readonly currency: string | null;
}

/**
 * The accepted corrections that each reduce a statement once. A correction re-issued under the same
 * economic effect key (accepted again as "already corrected") is the same reduction, not another one.
 */
const appliedCorrectionsOf = <
  Correction extends CorrectionRow & {
    readonly acceptanceOutcome: string;
    readonly economicEffectKey: string | null;
  },
>(
  observationId: string,
  corrections: readonly Correction[],
): readonly Correction[] => {
  const seenKeys = new Set<string>();
  return corrections.filter((correction) => {
    if (correction.acceptanceOutcome !== 'ACCEPTED_OBSERVATION' || correction.correctsObservationId !== observationId) {
      return false;
    }
    const key = correction.economicEffectKey;
    if (key === null) {
      return true;
    }
    if (seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);
    return true;
  });
};

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
    sourceBindingKey: [row.sourceKind, row.sourceSystem, row.accountRef, row.environment].join('\u0000'),
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
              accountRef: observations.accountRef,
              amountMinor: observations.amountMinor,
              currency: observations.currency,
              economicEffectKey: observations.economicEffectKey,
              environment: observations.environment,
              observationId: observations.observationId,
              operationId: observations.operationId,
              paymentId: observations.paymentId,
              sourceAuthorityId: observations.sourceAuthorityId,
              sourceKind: observations.sourceKind,
              sourceSystem: observations.sourceSystem,
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
              acceptanceOutcome: observations.acceptanceOutcome,
              amountMinor: observations.amountMinor,
              capabilityCorrelated: observations.capabilityCorrelated,
              correctsObservationId: observations.correctsObservationId,
              currency: observations.currency,
              economicEffectKey: observations.economicEffectKey,
              factKind: observations.factKind,
              paymentId: observations.paymentId,
              sourceAuthorityId: observations.sourceAuthorityId,
            })
            .from(observations)
            .where(
              and(
                ofPayment,
                eq(observations.factKind, 'SOURCE_CORRECTION'),
                inArray(observations.acceptanceOutcome, [...QUALIFIED_ACCEPTANCE]),
                isNotNull(observations.correctsObservationId),
              ),
            )
            .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
            .pipe(Effect.mapError(returnEvidenceReadFailure)),
        ],
        { concurrency: 1 },
      );
      // A fully disproven return (the shared rule, held retractions included) no longer counts at all;
      // otherwise only accepted corrections reduce what the statement still proves.
      const disproven = fullyDisprovenTargets(statements, corrections);
      const standing = statements.filter((row) => !disproven.has(row.observationId));
      const attached = yield* attachedOperationsOf(
        { legalEntityId, tenantId },
        standing.filter((row) => row.operationId === null).map((row) => row.observationId),
      );
      const evidence = yield* Effect.forEach(
        standing,
        (row) =>
          returnEvidenceOf(row, appliedCorrectionsOf(row.observationId, corrections), attached.get(row.observationId)),
        { concurrency: 1 },
      );
      return evidence.flatMap((entry) => (entry === null ? [] : [entry]));
    },
  );
  const selectFunds = Effect.fn('PaymentRefundPersistence.selectFunds')(function* selectFunds(
    aggregate: PaymentAggregateRecord,
  ) {
    const evidence = yield* selectReturnEvidence(aggregate.payment.paymentId);
    return {
      evidence,
      snapshot: fundsSnapshotWithPriorReturns(paymentFundsSnapshotOf(aggregate), evidence),
    } satisfies PaymentFundsReadout;
  });
  return Object.freeze({ selectFunds, selectRefundRouteCandidates, selectReturnEvidence });
};
