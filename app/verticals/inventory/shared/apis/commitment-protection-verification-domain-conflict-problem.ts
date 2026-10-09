import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const CommitmentProtectionVerificationDomainConflictProblemSchema = makeProblemDetailsSchema(
  'CommitmentProtectionVerificationDomainConflictProblem',
  409,
  { reasonCode: Schema.Literal('commitment_protection_scope_conflict') },
);
export type CommitmentProtectionVerificationDomainConflictProblem =
  typeof CommitmentProtectionVerificationDomainConflictProblemSchema.Type;
