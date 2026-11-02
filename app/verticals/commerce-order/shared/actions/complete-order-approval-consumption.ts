// Public contract adapted from the Codesmith-generated Action.
import { CompleteOrderApprovalConsumptionInputSchema } from '../domain/order-commitment.ts';

export const CompleteOrderApprovalConsumptionPayloadSchema = CompleteOrderApprovalConsumptionInputSchema;
export { OrderCommitmentStateSchema as CompleteOrderApprovalConsumptionResultSchema } from '../domain/order-commitment.ts';
export type CompleteOrderApprovalConsumptionPayload = typeof CompleteOrderApprovalConsumptionPayloadSchema.Type;
