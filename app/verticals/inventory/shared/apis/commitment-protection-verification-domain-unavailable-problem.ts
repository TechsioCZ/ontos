import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const CommitmentProtectionVerificationDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommitmentProtectionVerificationDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('commitment_protection_unavailable') },
);
export type CommitmentProtectionVerificationDomainUnavailableProblem =
  typeof CommitmentProtectionVerificationDomainUnavailableProblemSchema.Type;
