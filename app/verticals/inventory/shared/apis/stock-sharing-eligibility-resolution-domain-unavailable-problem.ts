import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const StockSharingEligibilityResolutionDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'StockSharingEligibilityResolutionDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('stock_sharing_eligibility_unavailable') },
);
export type StockSharingEligibilityResolutionDomainUnavailableProblem =
  typeof StockSharingEligibilityResolutionDomainUnavailableProblemSchema.Type;
