import { Schema } from 'effect';
import {
  SubmitPurchaseApprovalRequestInputSchema,
  SubmitPurchaseApprovalRequestResultSchema as DomainSubmitPurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';
export const SubmitPurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...SubmitPurchaseApprovalRequestInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type SubmitPurchaseApprovalRequestPayload =
  typeof SubmitPurchaseApprovalRequestPayloadSchema.Type;
export const SubmitPurchaseApprovalRequestResultSchema =
  DomainSubmitPurchaseApprovalRequestResultSchema;
export type SubmitPurchaseApprovalRequestResult =
  typeof SubmitPurchaseApprovalRequestResultSchema.Type;
export const SubmitPurchaseApprovalRequestRejected = PurchasingApprovalRejected;
export type SubmitPurchaseApprovalRequestRejected = InstanceType<typeof PurchasingApprovalRejected>;
