import { Option } from 'effect';

import type { PaymentOpenOperationView, PaymentReconciliationCaseView } from '../../shared/domain/evidence-contract.ts';
import type { PaymentHistoryView } from '../../shared/domain/evidence-history.ts';
import type {
  PaymentHistoryRecord,
  PaymentOpenOperationRecord,
  PaymentReconciliationCaseRecord,
} from '../persistence/payment-evidence-persistence.ts';

/** Projections of persisted #1151 evidence rows onto the public read contracts. */

export const reconciliationCaseView = (record: PaymentReconciliationCaseRecord): PaymentReconciliationCaseView => ({
  caseId: record.caseId,
  caseKind: record.caseKind,
  closedAt: Option.fromNullishOr(record.closedAt),
  observationId: Option.fromNullishOr(record.observationId),
  openedAt: record.openedAt,
  operationId: Option.fromNullishOr(record.operationId),
  paymentId: Option.fromNullishOr(record.paymentId),
  revision: record.revision,
  status: record.status,
});

export const openOperationView = (record: PaymentOpenOperationRecord): PaymentOpenOperationView => ({
  amount: record.amount,
  createdAt: record.createdAt,
  operationId: record.operationId,
  operationKind: record.kind,
  originalCompositionRevision: record.originalProvenance.compositionRevision,
  outcome: record.outcome,
  outcomeRevision: record.outcomeRevision,
  paymentId: record.paymentId,
});

/** The immutable history projection; `observedAt` is the actual read time, not a validity claim. */
export const paymentHistoryView = (
  record: PaymentHistoryRecord,
  observedAt: PaymentHistoryView['observedAt'],
): PaymentHistoryView => ({
  authorizations: record.authorizations.map((authorization) => ({
    amount: authorization.amount,
    authorizationId: authorization.authorizationId,
    coverageRevision: Option.fromNullishOr(authorization.coverageRevision),
    expiresAt: authorization.expiresAt,
    issuedAt: authorization.issuedAt,
    method: authorization.method,
    orderCommitmentAttemptId: authorization.orderCommitmentAttemptId,
    proofKind: authorization.proofKind,
    provenance: authorization.provenance,
  })),
  currentValidityClaimed: false,
  observations: record.observations.map((observation) => ({
    acceptanceOutcome: observation.acceptanceOutcome,
    amount: Option.fromNullishOr(observation.amount),
    correctsObservationId: Option.fromNullishOr(observation.correctsObservationId),
    economicEffectKey: Option.fromNullishOr(observation.economicEffectKey),
    evidenceRef: Option.fromNullishOr(observation.evidenceRef),
    factFamily: observation.factFamily,
    factKind: observation.factKind,
    observationId: observation.observationId,
    operationId: Option.fromNullishOr(observation.operationId),
    provenance: observation.provenance,
    receivedAt: observation.receivedAt,
    sourceAuthorityId: Option.fromNullishOr(observation.sourceAuthorityId),
    sourceKind: observation.sourceKind,
    sourceOccurredAt: Option.fromNullishOr(observation.sourceOccurredAt),
    sourceOccurrenceId: observation.sourceOccurrenceId,
    sourceRevision: observation.sourceRevision,
    verifiedAt: observation.verifiedAt,
  })),
  observedAt,
  operations: record.operations.map((operation) => ({
    amount: operation.amount,
    binding: operation.binding,
    createdAt: operation.createdAt,
    materialHash: operation.materialHash,
    operationId: operation.operationId,
    operationKey: operation.operationKey,
    operationKind: operation.kind,
    provenance: operation.provenance,
    refundBasisKind: Option.fromNullishOr(operation.refundBasisKind),
    targetOperationId: Option.fromNullishOr(operation.targetOperationId),
  })),
  payment: {
    amount: record.payment.amount,
    createdAt: record.payment.createdAt,
    executionBinding: record.payment.executionBinding,
    method: record.payment.method,
    paymentId: record.payment.paymentId,
    predecessorPaymentId: Option.fromNullishOr(record.payment.predecessorPaymentId),
    provenance: record.payment.provenance,
    purchaseCorrelationId: record.payment.purchaseCorrelationId,
  },
  projection: 'HISTORICAL_IMMUTABLE',
  reconciliationCases: record.cases.map(reconciliationCaseView),
  reconciliationDecisions: record.decisions.map((decision) => ({
    actionInvocationId: decision.provenance.actionInvocationId,
    caseId: decision.caseId,
    compositionRevision: decision.provenance.compositionRevision,
    decidedAt: decision.decidedAt,
    decisionId: decision.decisionId,
    decisionKind: decision.decisionKind,
    evidenceRef: Option.fromNullishOr(decision.evidenceRef),
    reason: decision.reason,
    resultingOutcome: Option.fromNullishOr(decision.resultingOutcome),
  })),
  recoveryRequests: record.recoveries.map((recovery) => ({
    binding: recovery.binding,
    mode: recovery.mode,
    operationId: recovery.operationId,
    provenance: recovery.provenance,
    reason: recovery.reason,
    recoveryId: recovery.recoveryId,
    requestedAt: recovery.requestedAt,
  })),
  transitions: record.transitions.map((transition) => ({
    causeId: Option.fromNullishOr(transition.causeId),
    causeKind: transition.causeKind,
    fromOutcome: Option.fromNullishOr(transition.fromOutcome),
    operationId: transition.operationId,
    outcomeRevision: transition.outcomeRevision,
    provenance: transition.provenance,
    recordedAt: transition.recordedAt,
    toOutcome: transition.toOutcome,
  })),
  truncated: record.truncated,
});
