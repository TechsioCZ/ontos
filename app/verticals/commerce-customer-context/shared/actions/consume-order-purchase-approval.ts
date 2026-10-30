import { Schema } from 'effect';
import { OrderCommitmentApprovalRequestSnapshotSchema } from '../apis/order-commitment-approval-evidence.ts';
import { ApprovalRevalidationRefSchema } from '../resources/approval-revalidation.ts';
import {
  ConsumePurchaseApprovalInputSchema,
  ConsumePurchaseApprovalResultSchema,
  OrderResourceRefSchema,
  PurchaseApprovalFinalBindingSchema,
} from '../domain/purchasing-approval.ts';

/** Lookup claims only. Buyer and consumption facts come exclusively from the committed Order owner. */
export const ConsumeOrderPurchaseApprovalPayloadSchema = Schema.Struct({
  finalBinding: PurchaseApprovalFinalBindingSchema,
  idempotencyKey: ConsumePurchaseApprovalInputSchema.fields.idempotencyKey,
  orderRef: OrderResourceRefSchema,
  revalidationRef: ApprovalRevalidationRefSchema,
});
export type ConsumeOrderPurchaseApprovalPayload = typeof ConsumeOrderPurchaseApprovalPayloadSchema.Type;
export const ConsumeOrderPurchaseApprovalResultSchema = Schema.Struct({
  outcome: ConsumePurchaseApprovalResultSchema.fields.outcome,
  request: OrderCommitmentApprovalRequestSnapshotSchema,
});
export type ConsumeOrderPurchaseApprovalResult = typeof ConsumeOrderPurchaseApprovalResultSchema.Type;
export { PurchasingApprovalRejected as ConsumeOrderPurchaseApprovalRejected } from '../domain/purchasing-approval.ts';
