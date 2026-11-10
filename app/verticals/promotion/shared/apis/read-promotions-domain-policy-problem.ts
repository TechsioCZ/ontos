import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ReadPromotionsDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'ReadPromotionsDomainPolicyProblem',
  422,
  { reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) },
);
