import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const RetailCustomerProfileDomainConflictProblemSchema = makeProblemDetailsSchema(
  'RetailCustomerProfileDomainConflictProblem',
  409,
  { reasonCode: Schema.Literal('retail_customer_profile_conflict') },
);
export type RetailCustomerProfileDomainConflictProblem = typeof RetailCustomerProfileDomainConflictProblemSchema.Type;
