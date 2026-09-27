import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const PurchaseCurrencyResolutionDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'PurchaseCurrencyResolutionDomainPolicyProblem',
  422,
  {
    reasonCode: Schema.Literals(['EXPLICIT_CHOICE_INVALID', 'NO_USABLE_CURRENCY']),
  },
);
export type PurchaseCurrencyResolutionDomainPolicyProblem =
  typeof PurchaseCurrencyResolutionDomainPolicyProblemSchema.Type;
