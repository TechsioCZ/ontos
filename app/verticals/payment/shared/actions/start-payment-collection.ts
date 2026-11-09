import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const StartPaymentCollectionPayloadSchema = Schema.Struct({});
export type StartPaymentCollectionPayload = typeof StartPaymentCollectionPayloadSchema.Type;

export const StartPaymentCollectionResultSchema = Schema.Struct({});
export type StartPaymentCollectionResult = typeof StartPaymentCollectionResultSchema.Type;
