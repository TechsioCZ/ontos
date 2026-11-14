import { Schema } from 'effect';

import {
  paymentLocalEvidenceFields,
  paymentSourcePaymentIdField,
  paymentSourceStatementFields,
} from '../domain/source-statement.ts';

/**
 * Operator/POS local evidence for one exact Payment (#1152 "Manual/local collection evidence"): only
 * from a configured LOCAL_POS_OPERATOR or MANUAL_EXTERNAL_REFUND source, with its own critical
 * permission, an auditable reason and an evidence reference. It is not a generic "mark paid" override:
 * it passes the same qualification, duplicate, conflict and correction rules as any other source.
 * For manual refund outcomes and corrections, evidenceRef identifies the original executor's
 * immutable verified record of the permitted destination and claimed effect.
 */
export const RecordPaymentLocalEvidencePayloadSchema = Schema.Struct({
  ...paymentSourceStatementFields,
  ...paymentSourcePaymentIdField,
  ...paymentLocalEvidenceFields,
});
export type RecordPaymentLocalEvidencePayload = typeof RecordPaymentLocalEvidencePayloadSchema.Type;

export { PaymentSourceStatementResultSchema as RecordPaymentLocalEvidenceResultSchema } from '../domain/source-statement.ts';
