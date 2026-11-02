// Public contract adapted from the generated commerce.order Action.
import { OrderAttemptMutationSchema } from '../domain/order-commitment.ts';

export const CancelOrderCommitmentPayloadSchema = OrderAttemptMutationSchema;
export { OrderCommitmentStateSchema as CancelOrderCommitmentResultSchema } from '../domain/order-commitment.ts';
export type CancelOrderCommitmentPayload = typeof CancelOrderCommitmentPayloadSchema.Type;
