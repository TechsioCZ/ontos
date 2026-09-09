import {
  RevalidatePurchaseApprovalInputSchema,
  RevalidatePurchaseApprovalResultSchema as DomainRevalidatePurchaseApprovalResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
export const RevalidatePurchaseApprovalPayloadSchema = Schema.Struct({
  ...RevalidatePurchaseApprovalInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type RevalidatePurchaseApprovalPayload = typeof RevalidatePurchaseApprovalPayloadSchema.Type;
export const RevalidatePurchaseApprovalResultSchema = DomainRevalidatePurchaseApprovalResultSchema;
export type RevalidatePurchaseApprovalResult = typeof RevalidatePurchaseApprovalResultSchema.Type;
export const RevalidatePurchaseApprovalRejected = PurchasingApprovalRejected;
export type RevalidatePurchaseApprovalRejected = InstanceType<typeof PurchasingApprovalRejected>;
