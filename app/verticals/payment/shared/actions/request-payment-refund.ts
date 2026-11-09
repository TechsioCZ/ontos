import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const RequestPaymentRefundPayloadSchema = Schema.Struct({});
export type RequestPaymentRefundPayload = typeof RequestPaymentRefundPayloadSchema.Type;

export const RequestPaymentRefundResultSchema = Schema.Struct({});
export type RequestPaymentRefundResult = typeof RequestPaymentRefundResultSchema.Type;
