import { FinalCartCandidateRefSchema } from '@app/commerce-cart-contracts/resources/final-cart-candidate';
import { Schema } from 'effect';
import { PurchaseApprovalRequestRefSchema } from '../resources/purchase-approval-request.ts';
import {
  CommitmentCorrelationIdSchema,
  PurchaseApprovalFinalBindingSchema,
  RevalidatePurchaseApprovalInputSchema,
} from '../domain/purchasing-approval.ts';

/** Lookup claims only; current buyer, policy and finalization facts are independently resolved by their owners. */
export const RevalidateOrderPurchaseApprovalPayloadSchema = Schema.Struct({
  candidateHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  candidateRef: FinalCartCandidateRefSchema,
  commitmentCorrelationId: CommitmentCorrelationIdSchema,
  finalBinding: PurchaseApprovalFinalBindingSchema,
  idempotencyKey: RevalidatePurchaseApprovalInputSchema.fields.idempotencyKey,
  requestRef: PurchaseApprovalRequestRefSchema,
});
export type RevalidateOrderPurchaseApprovalPayload = typeof RevalidateOrderPurchaseApprovalPayloadSchema.Type;
export { RevalidatePurchaseApprovalResultSchema as RevalidateOrderPurchaseApprovalResultSchema } from '../domain/purchasing-approval.ts';
export { PurchasingApprovalRejected as RevalidateOrderPurchaseApprovalRejected } from '../domain/purchasing-approval.ts';
export type { RevalidatePurchaseApprovalResult as RevalidateOrderPurchaseApprovalResult } from '../domain/purchasing-approval.ts';
