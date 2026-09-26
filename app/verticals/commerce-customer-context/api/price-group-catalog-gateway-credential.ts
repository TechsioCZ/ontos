import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { CustomerPriceGroupCatalogUnavailable } from '../shared/domain/price-group-errors.ts';
import { PriceGroupCatalogGatewayCredentialService } from '../shared/domain/price-group-catalog-gateway-credential.ts';
import type { PriceGroupCatalogGatewayCredentialIssuer } from '../shared/domain/price-group-catalog-gateway-credential.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Shell gateway URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: {
    readonly audience: 'price-group-catalog';
  },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const issueGatewayContextOverFetch: GatewayContextIssue = issueApiKeyGatewayContext;

const unavailable = (cause: unknown): CustomerPriceGroupCatalogUnavailable => {
  const failure = new CustomerPriceGroupCatalogUnavailable({
    code: 'customer_price_group_catalog_unavailable',
    reason: 'The server-owned Price Group Catalog credential could not be issued',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const unavailableConfigurationIssuer = (cause: unknown): PriceGroupCatalogGatewayCredentialIssuer =>
  Object.freeze({
    issue: () => {
      const failure = new CustomerPriceGroupCatalogUnavailable({
        code: 'customer_price_group_catalog_unavailable',
        reason: 'No server-owned Price Group Catalog gateway credential issuer is configured',
      });
      Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
      return Effect.fail(failure);
    },
  });

export const makePriceGroupCatalogGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly baseUrl: URL;
  },
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
): PriceGroupCatalogGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('PriceGroupCatalogGatewayCredentialIssuer.issue')(
      function* issuePriceGroupCatalogGatewayCredential(input: {
        readonly audience: 'price-group-catalog';
        readonly requestCorrelation: string;
      }) {
        const response = yield* issue(
          {
            audience: input.audience,
          },
          {
            apiKey: configured.apiKey,
            baseUrl: configured.baseUrl,
            requestCorrelation: input.requestCorrelation,
          },
        ).pipe(Effect.mapError(unavailable));
        return Redacted.make(`Bearer ${response.token}`);
      },
    ),
  });

/**
 * Success-capable production credential Layer. Configuration is deployment-owned and server-only;
 * missing or malformed configuration installs the explicit fail-closed issuer.
 */
export const makePriceGroupCatalogGatewayCredentialLayer = (
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
) =>
  Layer.effect(
    PriceGroupCatalogGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: unavailableConfigurationIssuer,
        onSuccess: (configured) => makePriceGroupCatalogGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const priceGroupCatalogGatewayCredentialLive = makePriceGroupCatalogGatewayCredentialLayer();
