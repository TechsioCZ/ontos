import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import { RevalidatePurchaseApprovalInputSchema, StorefrontIdSchema } from '../domain/purchasing-approval.ts';

export {
  RevalidatePurchaseApprovalResultSchema,
  PurchasingApprovalRejected as RevalidatePurchaseApprovalRejected,
} from '../domain/purchasing-approval.ts';
export type { RevalidatePurchaseApprovalResult } from '../domain/purchasing-approval.ts';

export const RevalidatePurchaseApprovalPayloadSchema = Schema.Struct({
  ...RevalidatePurchaseApprovalInputSchema.fields,
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type RevalidatePurchaseApprovalPayload = typeof RevalidatePurchaseApprovalPayloadSchema.Type;
