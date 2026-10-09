import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const PurchaseCurrencyResolutionDomainConflictProblemSchema = makeProblemDetailsSchema(
  'PurchaseCurrencyResolutionDomainConflictProblem',
  409,
  {
    reasonCode: Schema.Literal('INCONSISTENT_CURRENCY_POLICY'),
  },
);
export type PurchaseCurrencyResolutionDomainConflictProblem =
  typeof PurchaseCurrencyResolutionDomainConflictProblemSchema.Type;
