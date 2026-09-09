import {
  CreateApprovalHierarchyInputSchema,
  CreateApprovalHierarchyResultSchema as DomainCreateApprovalHierarchyResultSchema,
  PurchasingApprovalRejected,
} from '../domain/purchasing-approval.ts';
export const CreateApprovalHierarchyPayloadSchema = CreateApprovalHierarchyInputSchema;
export type CreateApprovalHierarchyPayload = typeof CreateApprovalHierarchyPayloadSchema.Type;
export const CreateApprovalHierarchyResultSchema = DomainCreateApprovalHierarchyResultSchema;
export type CreateApprovalHierarchyResult = typeof CreateApprovalHierarchyResultSchema.Type;
export const CreateApprovalHierarchyRejected = PurchasingApprovalRejected;
export type CreateApprovalHierarchyRejected = InstanceType<typeof PurchasingApprovalRejected>;
