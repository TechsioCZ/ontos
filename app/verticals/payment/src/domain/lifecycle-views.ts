import { Option } from 'effect';

import type { PaymentIntentView, PaymentOperationView } from '../../shared/domain/lifecycle-views.ts';
import type { PaymentOperationRecord, PaymentRecord } from '../persistence/payment-aggregate-persistence.ts';

/** Public projection of the persisted immutable Payment intent; original provenance is kept verbatim. */
export const paymentIntentViewOf = (record: PaymentRecord): PaymentIntentView => ({
  aggregateVersion: record.aggregateVersion,
  amount: record.amount,
  coverageRevision: record.coverageRevision,
  createdAt: record.createdAt,
  customerConfigurationId: record.customerConfigurationId,
  executionBinding: record.executionBinding,
  intentKey: record.intentKey,
  method: record.method,
  paymentId: record.paymentId,
  paymentTermRef: record.paymentTermRef,
  predecessorPaymentId: Option.fromNullishOr(record.predecessorPaymentId),
  provenance: record.provenance,
  purchaseCorrelationId: record.purchaseCorrelationId,
  termSemanticEvidence: record.termSemanticEvidence,
});

/** Public projection of one operation: identity, material hash, original binding and Current outcome. */
export const paymentOperationViewOf = (record: PaymentOperationRecord): PaymentOperationView => ({
  amount: record.amount,
  binding: record.binding,
  createdAt: record.createdAt,
  kind: record.kind,
  materialHash: record.materialHash,
  operationId: record.operationId,
  operationKey: record.operationKey,
  outcome: record.outcome,
  outcomeRevision: record.outcomeRevision,
  provenance: record.provenance,
  refundBasisKind: Option.fromNullishOr(record.refundBasis?._tag),
  targetOperationId: Option.fromNullishOr(record.targetOperationId),
});
