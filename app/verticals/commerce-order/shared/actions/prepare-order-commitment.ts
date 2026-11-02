// Public contract adapted from the generated commerce.order Action.
import { PrepareOrderCommitmentInputSchema } from '../domain/order-commitment.ts';

export const PrepareOrderCommitmentPayloadSchema = PrepareOrderCommitmentInputSchema;
export { OrderPreparationProgressSchema as PrepareOrderCommitmentResultSchema } from '../domain/order-commitment.ts';
export type PrepareOrderCommitmentPayload = typeof PrepareOrderCommitmentPayloadSchema.Type;
