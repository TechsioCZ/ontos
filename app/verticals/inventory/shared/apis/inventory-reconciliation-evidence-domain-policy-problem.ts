import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryReconciliationEvidenceDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'InventoryReconciliationEvidenceDomainPolicyProblem',
  422,
  { reasonCode: Schema.Literals(['CORRELATION_NOT_ENDED', 'EVIDENCE_LIMIT_EXCEEDED']) },
);
export type InventoryReconciliationEvidenceDomainPolicyProblem =
  typeof InventoryReconciliationEvidenceDomainPolicyProblemSchema.Type;
