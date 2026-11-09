import { Schema } from 'effect';

import {
  PaymentSourceStatementResultSchema,
  paymentLocalEvidenceFields,
  paymentSourcePaymentIdField,
  paymentSourceStatementFields,
} from '../domain/source-statement.ts';

/**
 * Operator/POS local evidence for one exact Payment (#1152 "Manual/local collection evidence"): only
 * from a configured LOCAL_POS_OPERATOR or MANUAL_EXTERNAL_REFUND source, with its own critical
 * permission, an auditable reason and an evidence reference. It is not a generic "mark paid" override:
 * it passes the same qualification, duplicate, conflict and correction rules as any other source, and a
 * manual refund route can report a refund request, never confirm returned money. No refund destination
 * can be supplied here.
 */
export const RecordPaymentLocalEvidencePayloadSchema = Schema.Struct({
  ...paymentSourceStatementFields,
  ...paymentSourcePaymentIdField,
  ...paymentLocalEvidenceFields,
});
export type RecordPaymentLocalEvidencePayload = typeof RecordPaymentLocalEvidencePayloadSchema.Type;

export const RecordPaymentLocalEvidenceResultSchema = PaymentSourceStatementResultSchema;
export type RecordPaymentLocalEvidenceResult = typeof RecordPaymentLocalEvidenceResultSchema.Type;
