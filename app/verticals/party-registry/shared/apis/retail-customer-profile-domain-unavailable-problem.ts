import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const RetailCustomerProfileDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'RetailCustomerProfileDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('retail_customer_profile_unavailable') },
);
export type RetailCustomerProfileDomainUnavailableProblem =
  typeof RetailCustomerProfileDomainUnavailableProblemSchema.Type;
