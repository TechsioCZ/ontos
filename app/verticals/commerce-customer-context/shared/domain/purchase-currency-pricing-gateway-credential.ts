import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { unavailablePurchaseCurrencyDependency } from './purchase-currency-dependency.ts';
import type { PurchaseCurrencyDependencyUnavailable } from './purchase-currency-dependency.ts';

export interface PurchaseCurrencyPricingGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

export interface PurchaseCurrencyPricingGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'pricing';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<PurchaseCurrencyPricingGatewayConnection, PurchaseCurrencyDependencyUnavailable>;
}

export class PurchaseCurrencyPricingGatewayCredentialService extends Context.Service<
  PurchaseCurrencyPricingGatewayCredentialService,
  PurchaseCurrencyPricingGatewayCredentialIssuer
>()(
  '@app/commerce-customer-context/shared/domain/purchase-currency-pricing-gateway-credential/PurchaseCurrencyPricingGatewayCredentialService',
) {}

export const unavailablePurchaseCurrencyPricingGatewayCredentialIssuer: PurchaseCurrencyPricingGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        unavailablePurchaseCurrencyDependency(
          'pricing_currency_support_unavailable',
          'No server-owned Pricing gateway credential issuer is configured',
        ),
      ),
  });
