import { Schema } from 'effect';
import { PurchaseApprovalTriggerResultSchema } from '../domain/purchase-limit-approval-trigger.ts';
import {
  PurchaseLimitEvaluationContextSchema,
  PurchaseLimitSourceRevisionVectorSchema,
} from '../domain/purchase-limit-evaluation.ts';
import { PurchaseLimitCounterpartyRefSchema } from '../domain/purchase-limit-policy.ts';
import { PurchaseValueSchema } from '../domain/purchase-limit.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';

const ProposalRevisionRefSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const TriggerPurchaseApprovalPayloadSchema = Schema.Struct({
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  expectedSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
  profileRef: Schema.Struct({
    kind: Schema.Literal('COUNTERPARTY'),
    ...CounterpartyPurchasingProfileRefSchema.fields,
  }),
  proposalRevisionRef: ProposalRevisionRefSchema,
  purchaseValue: PurchaseValueSchema,
  storefrontId: PurchaseLimitEvaluationContextSchema.fields.storefrontId,
}).check(
  Schema.makeFilter(({ proposalRevisionRef, purchaseValue }) =>
    proposalRevisionRef === purchaseValue.sourceRef
      ? undefined
      : 'proposalRevisionRef must equal the Purchase Value sourceRef',
  ),
);
export type TriggerPurchaseApprovalPayload = typeof TriggerPurchaseApprovalPayloadSchema.Type;

export const TriggerPurchaseApprovalResultSchema = PurchaseApprovalTriggerResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type TriggerPurchaseApprovalResult = typeof TriggerPurchaseApprovalResultSchema.Type;
