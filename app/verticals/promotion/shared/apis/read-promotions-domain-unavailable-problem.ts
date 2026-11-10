import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ReadPromotionsDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ReadPromotionsDomainUnavailableProblem',
  503,
  { reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) },
);
