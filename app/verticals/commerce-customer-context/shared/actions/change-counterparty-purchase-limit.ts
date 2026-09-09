// Canonical schema-only contract extracted from the generated change-counterparty-purchase-limit Action.
import { Schema } from 'effect';
import {
  PurchaseLimitCounterpartyRefSchema,
  PurchaseLimitPolicyChangeSchema,
  PurchaseLimitPolicyMutationResultSchema,
  PurchaseLimitRevisionSchema,
} from '../domain/purchase-limit-policy.ts';

export const ChangeCounterpartyPurchaseLimitPayloadSchema = Schema.Struct({
  change: PurchaseLimitPolicyChangeSchema,
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  expectedRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ChangeCounterpartyPurchaseLimitPayload =
  typeof ChangeCounterpartyPurchaseLimitPayloadSchema.Type;

export const ChangeCounterpartyPurchaseLimitResultSchema = PurchaseLimitPolicyMutationResultSchema;
export type ChangeCounterpartyPurchaseLimitResult =
  typeof ChangeCounterpartyPurchaseLimitResultSchema.Type;
