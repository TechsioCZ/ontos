import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { unavailablePurchaseCurrencyDependency } from '../shared/domain/purchase-currency-dependency.ts';
import type { PurchaseCurrencyDependencyUnavailable } from '../shared/domain/purchase-currency-dependency.ts';
import { PurchaseCurrencyPricingGatewayCredentialService } from '../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import type { PurchaseCurrencyPricingGatewayCredentialIssuer } from '../shared/domain/purchase-currency-pricing-gateway-credential.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Service URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);

const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  pricingBaseUrl: Config.schema(httpUrl, 'ONTOS_PRICING_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: { readonly audience: 'pricing'; readonly legalEntityId: string },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const unavailable = (reason: string, cause: unknown): PurchaseCurrencyDependencyUnavailable => {
  const failure = unavailablePurchaseCurrencyDependency('pricing_currency_support_unavailable', reason);
  return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const unavailableConfigurationIssuer = (cause: unknown): PurchaseCurrencyPricingGatewayCredentialIssuer => ({
  issue: () => Effect.fail(unavailable('Pricing gateway configuration is unavailable', cause)),
});

export const makePurchaseCurrencyPricingGatewayCredentialIssuer = (
  configured: { readonly apiKey: Redacted.Redacted; readonly pricingBaseUrl: URL; readonly shellBaseUrl: URL },
  issue: GatewayContextIssue = issueApiKeyGatewayContext,
): PurchaseCurrencyPricingGatewayCredentialIssuer => ({
  issue: Effect.fn('PurchaseCurrencyPricingGatewayCredentialIssuer.issue')(function* issueCredential(input) {
    const response = yield* issue(
      { audience: input.audience, legalEntityId: input.legalEntityId },
      {
        apiKey: configured.apiKey,
        baseUrl: configured.shellBaseUrl,
        requestCorrelation: input.requestCorrelation,
      },
    ).pipe(Effect.mapError((cause) => unavailable('The Pricing gateway credential could not be issued', cause)));
    return { baseUrl: configured.pricingBaseUrl, credential: Redacted.make(`Bearer ${response.token}`) };
  }),
});

export const makePurchaseCurrencyPricingGatewayCredentialLayer = (
  issue: GatewayContextIssue = issueApiKeyGatewayContext,
) =>
  Layer.effect(
    PurchaseCurrencyPricingGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: unavailableConfigurationIssuer,
        onSuccess: (configured) => makePurchaseCurrencyPricingGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const purchaseCurrencyPricingGatewayCredentialLive = makePurchaseCurrencyPricingGatewayCredentialLayer();
