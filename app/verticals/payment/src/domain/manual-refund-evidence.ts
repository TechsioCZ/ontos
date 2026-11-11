import { Effect, Option, Schema } from 'effect';

import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { paymentSourceRejected } from '../../shared/domain/source-statement.ts';
import type { PaymentAggregateRecord } from '../persistence/payment-aggregate-persistence.ts';
import {
  ManualRefundEvidencePort,
  PaymentManualRefundEvidenceSchema,
  PaymentManualRefundVerifiedFactSchema,
} from '../ports/manual-refund-evidence-port.ts';
import type { PaymentManualRefundEvidence } from '../ports/manual-refund-evidence-port.ts';
import { sameAmount } from './money.ts';
import { PaymentSourceQualification } from './source-qualification.ts';
import type {
  PaymentRecordedObservationView,
  PaymentSourceQualificationCase,
  PaymentSourceStatement,
} from './source-qualification.ts';

type ManualRefundVerifiedFact = typeof PaymentManualRefundVerifiedFactSchema.Type;
type QualifiedStatement = Extract<PaymentSourceQualificationCase, { readonly _tag: 'Qualified' }>;

const sameEvidence = Schema.toEquivalence(PaymentManualRefundEvidenceSchema);

const withExplicitOptionalClaimFields = (evidence: PaymentManualRefundEvidence): PaymentManualRefundEvidence => {
  const { amount, correctsObservationId, economicEffectKey, sourceOccurredAt } = evidence.claim;
  return {
    ...evidence,
    claim: { ...evidence.claim, amount, correctsObservationId, economicEffectKey, sourceOccurredAt },
  };
};

const manualRefundEvidenceMismatch = (reason: string) =>
  paymentSourceRejected('payment_source_authority_forbidden', reason);

const requireExactManualRefund = Effect.fn('PaymentSource.requireExactManualRefund')(function* requireExactManualRefund(
  statement: PaymentSourceStatement,
  factKind: ManualRefundVerifiedFact,
  observation: QualifiedStatement['observation'],
  target: Option.Option<PaymentAggregateRecord>,
  correctedObservation: Option.Option<PaymentRecordedObservationView>,
) {
  const { evidenceRef } = statement;
  const aggregate = Option.getOrUndefined(target);
  const { amount, operationId } = observation;
  const operation = aggregate?.operations.find((candidate) => candidate.operationId === operationId);
  if (aggregate === undefined || operation?.kind !== 'REFUND' || evidenceRef === undefined) {
    return yield* manualRefundEvidenceMismatch('Manual refund evidence must identify the exact refund and executor');
  }
  const { materialHash, refundBasis, refundExecutionRoute, targetOperationId } = operation;
  if (
    refundBasis === undefined ||
    refundExecutionRoute?.routeKind !== 'MANUAL_EXTERNAL' ||
    targetOperationId === undefined
  ) {
    return yield* manualRefundEvidenceMismatch('The original manual refund route or collection is unavailable');
  }
  if (factKind === 'SOURCE_CORRECTION') {
    const corrected = Option.getOrUndefined(correctedObservation);
    if ((corrected?.operationId ?? corrected?.attachedOperationId) !== operation.operationId) {
      return yield* manualRefundEvidenceMismatch('The corrected evidence does not belong to this exact refund');
    }
  } else if (amount === undefined || !sameAmount(amount, operation.amount)) {
    return yield* manualRefundEvidenceMismatch(
      'Manual refund evidence must state the exact refund amount and currency',
    );
  }
  const { legalEntityId, paymentId, tenantId } = aggregate.payment;
  return {
    claim: {
      amount,
      correctsObservationId: statement.correctsObservationId,
      economicEffectKey: statement.economicEffectKey,
      evidenceRef,
      factKind,
      sourceOccurredAt: statement.sourceOccurredAt,
      sourceOccurrenceId: statement.sourceOccurrenceId,
      sourceRevision: statement.sourceRevision,
    },
    materialHash,
    operationId: operation.operationId,
    paymentId,
    refundExecutionRoute,
    scope: { legalEntityId, tenantId },
    targetOperationId,
  };
});

/** Recheck the executor's retained record against the exact qualified claim and immutable refund. */
export const verifyManualRefundEvidence = Effect.fn('PaymentSource.verifyManualRefundEvidence')(
  function* verifyManualRefundEvidence(
    statement: PaymentSourceStatement,
    qualification: PaymentSourceQualificationCase,
    target: Option.Option<PaymentAggregateRecord>,
    correctedObservation: Option.Option<PaymentRecordedObservationView>,
  ) {
    const { factKind } = statement;
    if (
      statement.source.sourceKind !== 'MANUAL_EXTERNAL_REFUND' ||
      !Schema.is(PaymentManualRefundVerifiedFactSchema)(factKind)
    ) {
      return yield* Effect.void;
    }
    if (
      PaymentSourceQualification.$is('Held')(qualification) ||
      PaymentSourceQualification.$is('HeldUnassigned')(qualification)
    ) {
      return yield* manualRefundEvidenceMismatch('Manual refund evidence must identify the exact refund and executor');
    }
    if (!PaymentSourceQualification.$is('Qualified')(qualification)) {
      return yield* Effect.void;
    }
    const expected = yield* requireExactManualRefund(
      statement,
      factKind,
      qualification.observation,
      target,
      correctedObservation,
    );
    const verifier = yield* Effect.serviceOption(ManualRefundEvidencePort).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(paymentUnavailable('No governed manual refund evidence verifier is configured')),
          onSome: Effect.succeed,
        }),
      ),
    );
    const { refundExecutionRoute, scope } = expected;
    const evidence = yield* verifier.verify({ evidenceRef: expected.claim.evidenceRef, refundExecutionRoute, scope });
    if (
      !Schema.is(PaymentManualRefundEvidenceSchema)(evidence) ||
      !sameEvidence(withExplicitOptionalClaimFields(evidence), {
        ...expected,
        destinationEvidenceRef: evidence.destinationEvidenceRef,
      })
    ) {
      return yield* manualRefundEvidenceMismatch(
        'Executor evidence does not verify the exact refund, destination and outcome',
      );
    }
    return yield* Effect.void;
  },
);
