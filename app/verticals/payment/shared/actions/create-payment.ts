import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const CreatePaymentPayloadSchema = Schema.Struct({});
export type CreatePaymentPayload = typeof CreatePaymentPayloadSchema.Type;

export const CreatePaymentResultSchema = Schema.Struct({});
export type CreatePaymentResult = typeof CreatePaymentResultSchema.Type;
