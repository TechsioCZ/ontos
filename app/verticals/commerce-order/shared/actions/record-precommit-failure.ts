// Public contract adapted from the generated commerce.order Action.
import { RecordPrecommitFailureInputSchema } from '../domain/order-commitment.ts';

export const RecordPrecommitFailurePayloadSchema = RecordPrecommitFailureInputSchema;
export { OrderCommitmentStateSchema as RecordPrecommitFailureResultSchema } from '../domain/order-commitment.ts';
export type RecordPrecommitFailurePayload = typeof RecordPrecommitFailurePayloadSchema.Type;
