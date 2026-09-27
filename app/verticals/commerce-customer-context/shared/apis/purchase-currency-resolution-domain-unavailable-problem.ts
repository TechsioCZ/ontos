import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const PurchaseCurrencyResolutionDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'PurchaseCurrencyResolutionDomainUnavailableProblem',
  503,
  {
    reasonCode: Schema.Literals([
      'purchasing_context_unavailable',
      'currency_policy_unavailable',
      'pricing_currency_support_unavailable',
    ]),
  },
);
export type PurchaseCurrencyResolutionDomainUnavailableProblem =
  typeof PurchaseCurrencyResolutionDomainUnavailableProblemSchema.Type;
