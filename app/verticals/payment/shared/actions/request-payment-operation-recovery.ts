import { Schema } from 'effect';

import { PaymentRecoveryRequestViewSchema, PaymentRecoveryTriggerSchema } from '../domain/evidence-contract.ts';
import { PaymentIdSchema, PaymentOperationIdSchema, PaymentReasonSchema } from '../domain/payment-identifiers.ts';
import { PaymentRecoveryModeSchema } from '../domain/payment-vocabulary.ts';

/**
 * Request recovery of ONE existing Payment Operation (#1151). The request names the original
 * operation only: it can never carry a new operation key, account, environment or provider. The
 * recorded mode is derived from the stored binding and the actual time; `requestedMode` can only
 * ask for a weaker (never a stronger) mode.
 */
export const RequestPaymentOperationRecoveryPayloadSchema = Schema.Struct({
  operationId: PaymentOperationIdSchema,
  paymentId: PaymentIdSchema,
  reason: PaymentReasonSchema,
  requestedMode: Schema.optionalKey(PaymentRecoveryModeSchema),
  trigger: PaymentRecoveryTriggerSchema,
});
export type RequestPaymentOperationRecoveryPayload = typeof RequestPaymentOperationRecoveryPayloadSchema.Type;

export const RequestPaymentOperationRecoveryResultSchema = PaymentRecoveryRequestViewSchema;
export type RequestPaymentOperationRecoveryResult = typeof RequestPaymentOperationRecoveryResultSchema.Type;
