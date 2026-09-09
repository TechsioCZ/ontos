import {
  ConsumePurchaseApprovalInputSchema,
  ConsumePurchaseApprovalResultSchema as DomainConsumePurchaseApprovalResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';

export const ConsumePurchaseApprovalPayloadSchema = ConsumePurchaseApprovalInputSchema;
export type ConsumePurchaseApprovalPayload = typeof ConsumePurchaseApprovalPayloadSchema.Type;

export const ConsumePurchaseApprovalResultSchema = DomainConsumePurchaseApprovalResultSchema;
export type ConsumePurchaseApprovalResult = typeof ConsumePurchaseApprovalResultSchema.Type;

export const ConsumePurchaseApprovalRejected = PurchasingApprovalRejected;
export type ConsumePurchaseApprovalRejected = InstanceType<typeof PurchasingApprovalRejected>;
