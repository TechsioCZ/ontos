import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ReadPromotionsDomainConflictProblemSchema = makeProblemDetailsSchema(
  'ReadPromotionsDomainConflictProblem',
  409,
  { reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) },
);
