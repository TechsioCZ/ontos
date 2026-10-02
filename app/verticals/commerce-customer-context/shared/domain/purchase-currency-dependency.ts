import { Schema } from 'effect';

export class PurchaseCurrencyDependencyUnavailable extends Schema.TaggedError<PurchaseCurrencyDependencyUnavailable>()(
  'PurchaseCurrencyDependencyUnavailable',
  {
    code: Schema.Literals([
      'purchasing_context_unavailable',
      'currency_policy_unavailable',
      'pricing_currency_support_invalid',
      'pricing_currency_support_stale',
      'pricing_currency_support_unavailable',
      'pricing_currency_support_unverifiable',
    ]),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}

export const unavailablePurchaseCurrencyDependency = (
  code: PurchaseCurrencyDependencyUnavailable['code'],
  reason: string,
) => PurchaseCurrencyDependencyUnavailable.make({ code, reason, retryable: true });
