import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const AcceptPaymentObservationPayloadSchema = Schema.Struct({});
export type AcceptPaymentObservationPayload = typeof AcceptPaymentObservationPayloadSchema.Type;

export const AcceptPaymentObservationResultSchema = Schema.Struct({});
export type AcceptPaymentObservationResult = typeof AcceptPaymentObservationResultSchema.Type;
