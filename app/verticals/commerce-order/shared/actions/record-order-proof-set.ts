// Public contract adapted from the Codesmith-generated Action.
import { RecordOrderProofSetInputSchema } from '../domain/order-commitment.ts';

export const RecordOrderProofSetPayloadSchema = RecordOrderProofSetInputSchema;
export { OrderProofProgressSchema as RecordOrderProofSetResultSchema } from '../domain/order-commitment.ts';
export type RecordOrderProofSetPayload = typeof RecordOrderProofSetPayloadSchema.Type;
