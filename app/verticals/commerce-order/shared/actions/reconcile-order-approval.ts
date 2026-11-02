// Public contract adapted from the generated commerce.order Action.
import { Schema } from 'effect';
import { OrderFinalBindingSchema } from '../domain/order-commitment.ts';

export const ReconcileOrderApprovalPayloadSchema = Schema.Struct({ binding: OrderFinalBindingSchema });
export { OrderCommitmentStateSchema as ReconcileOrderApprovalResultSchema } from '../domain/order-commitment.ts';
export type ReconcileOrderApprovalPayload = typeof ReconcileOrderApprovalPayloadSchema.Type;
