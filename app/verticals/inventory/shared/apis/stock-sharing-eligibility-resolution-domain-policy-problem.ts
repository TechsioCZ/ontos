import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { StockSharingEligibilityRejected } from '../domain/stock-sharing-eligibility.ts';

export const StockSharingEligibilityResolutionDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'StockSharingEligibilityResolutionDomainPolicyProblem',
  422,
  { reasonCode: StockSharingEligibilityRejected.fields.reason },
);
export type StockSharingEligibilityResolutionDomainPolicyProblem =
  typeof StockSharingEligibilityResolutionDomainPolicyProblemSchema.Type;
