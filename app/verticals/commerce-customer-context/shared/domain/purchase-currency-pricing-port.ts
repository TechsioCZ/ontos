import { Context, Effect } from 'effect';
import { unavailablePurchaseCurrencyDependency } from './purchase-currency-dependency.ts';
import type { PurchaseCurrencyDependencyUnavailable } from './purchase-currency-dependency.ts';
import type { PricingCurrencySupport, PurchaseCurrencyCurrentFacts } from './purchase-currency-resolution.ts';

export interface PurchaseCurrencyPricingPortService {
  readonly resolveCurrent: (input: {
    readonly context: Pick<PurchaseCurrencyCurrentFacts, 'contextRevision' | 'purchasingContext'>;
    readonly observedAt: string;
  }) => Effect.Effect<PricingCurrencySupport, PurchaseCurrencyDependencyUnavailable>;
}

export class PurchaseCurrencyPricingPort extends Context.Service<
  PurchaseCurrencyPricingPort,
  PurchaseCurrencyPricingPortService
>()('@app/commerce-customer-context/shared/domain/purchase-currency-pricing-port/PurchaseCurrencyPricingPort') {}

export const unavailablePurchaseCurrencyPricingPort = (): PurchaseCurrencyPricingPortService => ({
  resolveCurrent: () =>
    Effect.fail(
      unavailablePurchaseCurrencyDependency(
        'pricing_currency_support_unavailable',
        'The Current Pricing Currency Support provider is not configured',
      ),
    ),
});
