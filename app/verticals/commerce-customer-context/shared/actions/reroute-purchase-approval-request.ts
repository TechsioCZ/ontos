import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import { ReroutePurchaseApprovalRequestInputSchema, StorefrontIdSchema } from '../domain/purchasing-approval.ts';

export {
  ReroutePurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected as ReroutePurchaseApprovalRequestRejected,
} from '../domain/purchasing-approval.ts';
export type { ReroutePurchaseApprovalRequestResult } from '../domain/purchasing-approval.ts';

export const ReroutePurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...ReroutePurchaseApprovalRequestInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type ReroutePurchaseApprovalRequestPayload = typeof ReroutePurchaseApprovalRequestPayloadSchema.Type;
