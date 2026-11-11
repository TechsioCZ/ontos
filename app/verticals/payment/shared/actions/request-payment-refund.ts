import { Schema } from 'effect';

import { PaymentOperationViewSchema } from '../domain/lifecycle-views.ts';
import {
  PaymentIdSchema,
  PaymentOperationKeySchema,
  PaymentReasonSchema,
  PaymentRevisionSchema,
} from '../domain/payment-identifiers.ts';
import { PaymentPositiveMonetaryAmountSchema } from '../domain/payment-money.ts';
import { PaymentRefundBasisSchema } from '../domain/payment-refund-basis.ts';
import { PaymentRefundExecutionRouteSchema } from '../domain/refund-contract.ts';

/**
 * Request one REFUND of already proven collection (#1150). It carries exactly one immutable basis:
 * complete authoritative refundable items, or failed-commitment compensation. The refund destination
 * is never part of the request; the configured executor establishes it under its own contract.
 */
export const RequestPaymentRefundPayloadSchema = Schema.Struct({
  /** Exact amount in the original collection currency; for items it equals their full sum. */
  amount: PaymentPositiveMonetaryAmountSchema,
  basis: PaymentRefundBasisSchema,
  /** Stable logical operation identity: the same key and request is the same REFUND. */
  operationKey: PaymentOperationKeySchema,
  paymentId: PaymentIdSchema,
  /** Authorized business reason; part of the immutable refund request. */
  reason: PaymentReasonSchema,
});
export type RequestPaymentRefundPayload = typeof RequestPaymentRefundPayloadSchema.Type;

export const RequestPaymentRefundResultSchema = Schema.Struct({
  /** Coverage revision after the request; starting a refund makes earlier prepaid proofs unusable. */
  coverageRevision: PaymentRevisionSchema,
  /**
   * The configured executor the REFUND was requested through, stored immutably with the operation; a
   * replay returns the original route, never a newly selected one.
   */
  executionRoute: Schema.optionalKey(PaymentRefundExecutionRouteSchema),
  operation: PaymentOperationViewSchema,
  refundBasis: PaymentRefundBasisSchema,
  /** True when the same logical REFUND already existed: nothing was reserved or requested again. */
  replayed: Schema.Boolean,
});
export type RequestPaymentRefundResult = typeof RequestPaymentRefundResultSchema.Type;
