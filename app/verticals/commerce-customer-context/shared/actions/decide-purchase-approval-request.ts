import {
  DecidePurchaseApprovalRequestInputSchema,
  DecidePurchaseApprovalRequestResultSchema as DomainDecidePurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
import { CoreSearchResourceRefSchema, PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
export const DecidePurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...DecidePurchaseApprovalRequestInputSchema.fields,
  actor: Schema.optionalKey(PrincipalRefSchema),
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type DecidePurchaseApprovalRequestPayload =
  typeof DecidePurchaseApprovalRequestPayloadSchema.Type;
export const DecidePurchaseApprovalRequestResultSchema =
  DomainDecidePurchaseApprovalRequestResultSchema;
export type DecidePurchaseApprovalRequestResult =
  typeof DecidePurchaseApprovalRequestResultSchema.Type;
export const DecidePurchaseApprovalRequestRejected = PurchasingApprovalRejected;
export type DecidePurchaseApprovalRequestRejected = InstanceType<typeof PurchasingApprovalRejected>;
