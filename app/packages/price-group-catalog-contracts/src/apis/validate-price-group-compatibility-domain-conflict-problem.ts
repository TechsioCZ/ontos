import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ValidatePriceGroupCompatibilityDomainConflictProblemSchema = makeProblemDetailsSchema(
  'ValidatePriceGroupCompatibilityDomainConflictProblem',
  409,
  {
    reasonCode: Schema.Literal('STALE_EXPECTED_EVIDENCE'),
  },
);
export type ValidatePriceGroupCompatibilityDomainConflictProblem =
  typeof ValidatePriceGroupCompatibilityDomainConflictProblemSchema.Type;
