import { Schema } from 'effect';

import { PaymentOperationViewSchema } from '../domain/lifecycle-views.ts';
import {
  PaymentIdSchema,
  PaymentOperationIdSchema,
  PaymentOperationKeySchema,
  PaymentReasonSchema,
  PaymentRevisionSchema,
} from '../domain/payment-identifiers.ts';

/**
 * Request CANCEL_OR_VOID of one collection before its effect is proven (#1150). It never rewrites a
 * proven collection: once collection is proven, returning funds needs a separate REFUND.
 */
export const RequestPaymentCancellationPayloadSchema = Schema.Struct({
  /** Stable logical operation identity: the same key and request is the same cancellation. */
  operationKey: PaymentOperationKeySchema,
  paymentId: PaymentIdSchema,
  /** Authorized business reason; part of the immutable cancellation request. */
  reason: PaymentReasonSchema,
  /** The exact COLLECT of this Payment to stop or void. */
  targetOperationId: PaymentOperationIdSchema,
});
export type RequestPaymentCancellationPayload = typeof RequestPaymentCancellationPayloadSchema.Type;

export const RequestPaymentCancellationResultSchema = Schema.Struct({
  coverageRevision: PaymentRevisionSchema,
  operation: PaymentOperationViewSchema,
  /** True when the same logical cancellation already existed: nothing was requested again. */
  replayed: Schema.Boolean,
});
export type RequestPaymentCancellationResult = typeof RequestPaymentCancellationResultSchema.Type;
