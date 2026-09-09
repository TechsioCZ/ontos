import {
  CreatePurchaseProposalRevisionInputSchema,
  CreatePurchaseProposalRevisionResultSchema as DomainCreatePurchaseProposalRevisionResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
export const CreatePurchaseProposalRevisionPayloadSchema =
  CreatePurchaseProposalRevisionInputSchema;
export type CreatePurchaseProposalRevisionPayload =
  typeof CreatePurchaseProposalRevisionPayloadSchema.Type;
export const CreatePurchaseProposalRevisionResultSchema =
  DomainCreatePurchaseProposalRevisionResultSchema;
export type CreatePurchaseProposalRevisionResult =
  typeof CreatePurchaseProposalRevisionResultSchema.Type;
export const CreatePurchaseProposalRevisionRejected = PurchasingApprovalRejected;
export type CreatePurchaseProposalRevisionRejected = InstanceType<
  typeof PurchasingApprovalRejected
>;
