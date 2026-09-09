import {
  ReroutePurchaseApprovalRequestInputSchema,
  ReroutePurchaseApprovalRequestResultSchema as DomainReroutePurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
export const ReroutePurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...ReroutePurchaseApprovalRequestInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type ReroutePurchaseApprovalRequestPayload =
  typeof ReroutePurchaseApprovalRequestPayloadSchema.Type;
export const ReroutePurchaseApprovalRequestResultSchema =
  DomainReroutePurchaseApprovalRequestResultSchema;
export type ReroutePurchaseApprovalRequestResult =
  typeof ReroutePurchaseApprovalRequestResultSchema.Type;
export const ReroutePurchaseApprovalRequestRejected = PurchasingApprovalRejected;
export type ReroutePurchaseApprovalRequestRejected = InstanceType<
  typeof PurchasingApprovalRejected
>;
