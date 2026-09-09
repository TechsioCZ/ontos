import { Schema } from 'effect';
import {
  PaymentTermReferenceSchema,
  PaymentTermsTimestampSchema,
} from '../domain/payment-term-contracts.ts';

const ReservationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PaymentTermRetirementReservationId'),
  Schema.decodeTo(Schema.String),
);
const PaymentTermResourceIdSchema = PaymentTermReferenceSchema.fields.resourceId;
const BoundedReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const PaymentTermRetirementReservationOperationSchema = Schema.Literals([
  'RESERVE',
  'COMMIT',
  'RELEASE',
]);
export type PaymentTermRetirementReservationOperation =
  typeof PaymentTermRetirementReservationOperationSchema.Type;

/**
 * The canonical term is sent separately so the owner can reject a request whose alias inventory
 * was not built from the retiring definition. Equivalent references are a bounded batch and may
 * contain aliases only; the owner deduplicates the complete resource-id set before reserving it.
 */
export const ReservePaymentTermRetirementPayloadSchema = Schema.Struct({
  effectiveAt: PaymentTermsTimestampSchema,
  equivalentPaymentTermRefs: Schema.Array(PaymentTermReferenceSchema).check(
    Schema.isMaxLength(199),
  ),
  operation: PaymentTermRetirementReservationOperationSchema,
  paymentTermRef: PaymentTermReferenceSchema,
  reason: BoundedReasonSchema,
  reservationRef: Schema.optionalKey(ReservationIdSchema),
});
export type ReservePaymentTermRetirementPayload =
  typeof ReservePaymentTermRetirementPayloadSchema.Type;

export const ReservePaymentTermRetirementResultSchema = Schema.Struct({
  effectiveAt: PaymentTermsTimestampSchema,
  lifecycle: Schema.Literals(['RESERVED', 'COMMITTED', 'RELEASED']),
  paymentTermResourceIds: Schema.Array(PaymentTermResourceIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
  reservationRef: ReservationIdSchema,
});
export type ReservePaymentTermRetirementResult =
  typeof ReservePaymentTermRetirementResultSchema.Type;
