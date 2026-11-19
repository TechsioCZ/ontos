import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const LanguagePolicyDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'LanguagePolicyDomainUnavailableProblem',
  503,
  { reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)) },
);
