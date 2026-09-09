import { Schema } from 'effect';

export class PurchaseCurrencyDependencyUnavailable extends Schema.TaggedError<PurchaseCurrencyDependencyUnavailable>()(
  'PurchaseCurrencyDependencyUnavailable',
  {
    code: Schema.Literals([
      'purchasing_context_unavailable',
      'currency_policy_unavailable',
      'pricing_currency_support_unavailable',
      'customer_currency_preference_unavailable',
    ]),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}

export const unavailablePurchaseCurrencyDependency = (
  code: PurchaseCurrencyDependencyUnavailable['code'],
  reason: string,
) => PurchaseCurrencyDependencyUnavailable.make({ code, reason, retryable: true });
