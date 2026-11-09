import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const RequestPaymentCancellationPayloadSchema = Schema.Struct({});
export type RequestPaymentCancellationPayload = typeof RequestPaymentCancellationPayloadSchema.Type;

export const RequestPaymentCancellationResultSchema = Schema.Struct({});
export type RequestPaymentCancellationResult = typeof RequestPaymentCancellationResultSchema.Type;
