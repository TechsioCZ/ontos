import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { CurrentStockEvidenceForAvailabilityRejected } from '../domain/current-stock-evidence-for-availability.ts';

export const CurrentStockEvidenceForAvailabilityDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'CurrentStockEvidenceForAvailabilityDomainPolicyProblem',
  422,
  { reasonCode: CurrentStockEvidenceForAvailabilityRejected.fields.reason },
);
export type CurrentStockEvidenceForAvailabilityDomainPolicyProblem =
  typeof CurrentStockEvidenceForAvailabilityDomainPolicyProblemSchema.Type;
