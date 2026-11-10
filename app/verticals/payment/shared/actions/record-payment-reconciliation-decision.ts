import { Schema } from 'effect';

import {
  PaymentOperationOutcomeChangeViewSchema,
  PaymentReconciliationDecisionBodySchema,
  PaymentReconciliationDecisionViewSchema,
} from '../domain/evidence-contract.ts';
import {
  PaymentIdSchema,
  PaymentReasonSchema,
  PaymentReconciliationCaseIdSchema,
  PaymentRevisionSchema,
} from '../domain/payment-identifiers.ts';
import {
  PaymentReconciliationCaseKindSchema,
  PaymentReconciliationCaseStatusSchema,
} from '../domain/payment-vocabulary.ts';

/**
 * One governed, audited reconciliation decision on one case (#1151). It may attach qualified evidence
 * from a configured ACTIVE source, classify a conflict or close an administrative case; it never
 * creates money, never confirms an effect without qualified evidence and never closes a case while
 * its operation is still unresolved.
 */
export const RecordPaymentReconciliationDecisionPayloadSchema = Schema.Struct({
  caseId: PaymentReconciliationCaseIdSchema,
  decision: PaymentReconciliationDecisionBodySchema,
  reason: PaymentReasonSchema,
});
export type RecordPaymentReconciliationDecisionPayload = typeof RecordPaymentReconciliationDecisionPayloadSchema.Type;

export const RecordPaymentReconciliationDecisionResultSchema = Schema.Struct({
  caseId: PaymentReconciliationCaseIdSchema,
  caseKind: PaymentReconciliationCaseKindSchema,
  caseRevision: PaymentRevisionSchema,
  caseStatus: PaymentReconciliationCaseStatusSchema,
  decision: PaymentReconciliationDecisionViewSchema,
  outcomeChange: Schema.OptionFromNullOr(PaymentOperationOutcomeChangeViewSchema),
  paymentId: Schema.OptionFromNullOr(PaymentIdSchema),
});
export type RecordPaymentReconciliationDecisionResult = typeof RecordPaymentReconciliationDecisionResultSchema.Type;
