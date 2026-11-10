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
import {
  economicEffectAttributions,
  observations,
  reconciliationDecisions,
  sourceAuthorities,
} from '../database/schema.ts';
import type { PaymentRefundRouteCandidate } from '../domain/refund-execution-route.ts';
import type { PaymentFundsSnapshot } from '../domain/coverage.ts';
import {
  appliedCorrectionsOf,
  correctionReachOf,
  fundsSnapshotWithPriorReturns,
} from '../domain/refund-prior-returns.ts';
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
 * One statement as the refund guard reads it. A statement fully covered by its accepted corrections
 * is gone (undefined). A partially corrected statement keeps its stated money and the corrected part.
 * A statement held without an operation counts toward the operation its governed attachment resulted in.
 */
const returnEvidenceOf = Effect.fn('PaymentRefundPersistence.returnEvidenceOf')(function* returnEvidenceOf(
  row: ReturnStatementRow,
  corrections: readonly CorrectionRow[],
  attachedOperationId: string | undefined,
  attributedElsewhere: boolean,
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
    attributedElsewhere,
    correctedAmount: reach.correctedAmount,
    economicEffectKey: row.economicEffectKey ?? undefined,
    observationId: row.observationId,
    operationId: row.operationId ?? attachedOperationId,
    // NUL cannot occur in PostgreSQL text, so it separates the four binding fields unambiguously.
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
   * The operation governance assigned each return statement to (#1151): the operation of its latest
   * ATTACH_EVIDENCE decision. An attachment that confirmed a REFUND and one that only assigned the return
   * to the collection it returned (no outcome change) both count: the reader decides what the operation
   * makes of the statement.
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
        if (row.evidenceRef !== null && row.operationId !== null) {
          attached.set(row.evidenceRef, row.operationId);
        }
      }
      return attached;
    },
  );
  /**
   * The return statements whose economic effect the scope-wide attribution ledger already counts for an
   * operation of another Payment (#1151 "one economic effect counts once"). The ledger is append-only,
   * so reading it needs no lock.
   */
  const attributedToOtherPayment = Effect.fn('PaymentRefundPersistence.attributedToOtherPayment')(
    function* attributedToOtherPayment(
      scope: { readonly legalEntityId: string; readonly tenantId: string },
      paymentId: string,
      statements: readonly ReturnStatementRow[],
    ) {
      const keys = [...new Set(statements.flatMap((row) => row.economicEffectKey ?? []))];
      if (keys.length === 0) {
        return new Set<string>();
      }
      const attributions = yield* transaction
        .select({
          accountRef: economicEffectAttributions.accountRef,
          economicEffectKey: economicEffectAttributions.economicEffectKey,
          environment: economicEffectAttributions.environment,
          paymentId: economicEffectAttributions.paymentId,
          sourceKind: economicEffectAttributions.sourceKind,
          sourceSystem: economicEffectAttributions.sourceSystem,
        })
        .from(economicEffectAttributions)
        .where(
          and(
            eq(economicEffectAttributions.tenantId, scope.tenantId),
            eq(economicEffectAttributions.legalEntityId, scope.legalEntityId),
            eq(economicEffectAttributions.factKind, 'REFUND_CONFIRMED'),
            inArray(economicEffectAttributions.economicEffectKey, keys),
          ),
        )
        .pipe(Effect.mapError(returnEvidenceReadFailure));
      const foreign = attributions.filter((attribution) => attribution.paymentId !== paymentId);
      return new Set(
        statements.flatMap((row) =>
          foreign.some(
            (attribution) =>
              attribution.economicEffectKey === row.economicEffectKey &&
              attribution.sourceKind === row.sourceKind &&
              attribution.sourceSystem === row.sourceSystem &&
              attribution.accountRef === row.accountRef &&
              attribution.environment === row.environment,
          )
            ? [row.observationId]
            : [],
        ),
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
              accountRef: observations.accountRef,
              amountMinor: observations.amountMinor,
              capabilityCorrelated: observations.capabilityCorrelated,
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
      // A selected-capability source (carrier, POS) that never proved the selected capability proves no
      // return: its statement stays unresolved debt of its own case, never a counted return (#1152).
      const standing = statements.filter(
        (row) => !disproven.has(row.observationId) && row.capabilityCorrelated !== false,
      );
      const [attached, elsewhere] = yield* Effect.all(
        [
          attachedOperationsOf(
            { legalEntityId, tenantId },
            standing.filter((row) => row.operationId === null).map((row) => row.observationId),
          ),
          attributedToOtherPayment({ legalEntityId, tenantId }, paymentId, standing),
        ],
        { concurrency: 1 },
      );
      const evidence = yield* Effect.forEach(
        standing,
        (row) =>
          returnEvidenceOf(
            row,
            appliedCorrectionsOf(row.observationId, corrections),
            attached.get(row.observationId),
            elsewhere.has(row.observationId),
          ),
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
