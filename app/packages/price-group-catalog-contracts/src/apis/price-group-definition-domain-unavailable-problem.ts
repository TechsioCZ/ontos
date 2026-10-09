import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const PriceGroupDefinitionDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'PriceGroupDefinitionDomainUnavailableProblem',
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
export type PriceGroupDefinitionDomainUnavailableProblem =
  typeof PriceGroupDefinitionDomainUnavailableProblemSchema.Type;
