// Canonical schema-only contract extracted from the generated change-principal-purchase-limit-override Action.
import { PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import {
  PurchaseLimitCounterpartyRefSchema,
  PurchaseLimitPolicyChangeSchema,
  PurchaseLimitPolicyMutationResultSchema,
  PurchaseLimitRevisionSchema,
} from '../domain/purchase-limit-policy.ts';

export const ChangePrincipalPurchaseLimitOverridePayloadSchema = Schema.Struct({
  change: PurchaseLimitPolicyChangeSchema,
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  expectedRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  principalRef: PrincipalRefSchema,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ChangePrincipalPurchaseLimitOverridePayload =
  typeof ChangePrincipalPurchaseLimitOverridePayloadSchema.Type;

export const ChangePrincipalPurchaseLimitOverrideResultSchema =
  PurchaseLimitPolicyMutationResultSchema;
export type ChangePrincipalPurchaseLimitOverrideResult =
  typeof ChangePrincipalPurchaseLimitOverrideResultSchema.Type;
