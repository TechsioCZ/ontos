import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const CurrentStockEvidenceForAvailabilityDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CurrentStockEvidenceForAvailabilityDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('current_stock_evidence_for_availability_unavailable') },
);
export type CurrentStockEvidenceForAvailabilityDomainUnavailableProblem =
  typeof CurrentStockEvidenceForAvailabilityDomainUnavailableProblemSchema.Type;
