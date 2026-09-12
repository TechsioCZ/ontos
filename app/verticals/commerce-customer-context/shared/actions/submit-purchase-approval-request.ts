import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import { StorefrontIdSchema, SubmitPurchaseApprovalRequestInputSchema } from '../domain/purchasing-approval.ts';

export {
  SubmitPurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected as SubmitPurchaseApprovalRequestRejected,
} from '../domain/purchasing-approval.ts';
export type { SubmitPurchaseApprovalRequestResult } from '../domain/purchasing-approval.ts';

export const SubmitPurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...SubmitPurchaseApprovalRequestInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type SubmitPurchaseApprovalRequestPayload = typeof SubmitPurchaseApprovalRequestPayloadSchema.Type;
