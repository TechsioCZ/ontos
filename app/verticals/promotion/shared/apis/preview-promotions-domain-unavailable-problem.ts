import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const PreviewPromotionsDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'PreviewPromotionsDomainUnavailableProblem',
  503,
  { reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) },
);
