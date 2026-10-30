// Public contract adapted from the generated commerce.order Action.
import { CommitOrderInputSchema } from '../domain/order-commitment.ts';

export const CommitOrderPayloadSchema = CommitOrderInputSchema;
export { OrderCommitmentStateSchema as CommitOrderResultSchema } from '../domain/order-commitment.ts';
export type CommitOrderPayload = typeof CommitOrderPayloadSchema.Type;
