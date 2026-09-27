import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ValidatePriceGroupCompatibilityDomainUnavailableProblem',
  503,
  {
    reasonCode: Schema.Literals([
      'MULTIPLE_CURRENT_DEFINITIONS',
      'OWNER_UNAVAILABLE',
      'UNVERIFIABLE_CURRENTNESS',
      'ZERO_CURRENT_DEFINITIONS',
    ]),
  },
);
export type ValidatePriceGroupCompatibilityDomainUnavailableProblem =
  typeof ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema.Type;
