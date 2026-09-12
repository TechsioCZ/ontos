import { CoreSearchResourceRefSchema, PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import { DecidePurchaseApprovalRequestInputSchema, StorefrontIdSchema } from '../domain/purchasing-approval.ts';

export {
  DecidePurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected as DecidePurchaseApprovalRequestRejected,
} from '../domain/purchasing-approval.ts';
export type { DecidePurchaseApprovalRequestResult } from '../domain/purchasing-approval.ts';

export const DecidePurchaseApprovalRequestPayloadSchema = Schema.Struct({
  ...DecidePurchaseApprovalRequestInputSchema.fields,
  actor: Schema.optionalKey(PrincipalRefSchema),
  counterpartyRef: CoreSearchResourceRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type DecidePurchaseApprovalRequestPayload = typeof DecidePurchaseApprovalRequestPayloadSchema.Type;
