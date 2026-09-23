import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { CatalogQuantityGatewayCredentialService } from '../shared/domain/catalog-quantity-gateway-credential.ts';
import type { CatalogQuantityGatewayCredentialIssuer } from '../shared/domain/catalog-quantity-gateway-credential.ts';
import type { CommerceQuantityCatalogUnavailable } from '../shared/domain/commerce-quantity-catalog-port.ts';

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
  apiKey: Config.redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  catalogBaseUrl: Config.schema(httpUrl, 'ONTOS_CATALOG_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: { readonly audience: 'catalog'; readonly legalEntityId: string },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const unavailable = (reason: string, cause: unknown): CommerceQuantityCatalogUnavailable =>
  Object.defineProperty(
    {
      _tag: 'CommerceQuantityCatalogUnavailable' as const,
      code: 'catalog_selection_unavailable' as const,
      reason,
      retryable: true as const,
    },
    'cause',
    { configurable: true, value: cause },
  );

const unavailableConfigurationIssuer = (cause: unknown): CatalogQuantityGatewayCredentialIssuer => ({
  issue: () => Effect.fail(unavailable('Catalog gateway configuration is unavailable', cause)),
});

export const makeCatalogQuantityGatewayCredentialIssuer = (
  configured: { readonly apiKey: Redacted.Redacted; readonly catalogBaseUrl: URL; readonly shellBaseUrl: URL },
  issue: GatewayContextIssue = issueApiKeyGatewayContext,
): CatalogQuantityGatewayCredentialIssuer => ({
  issue: Effect.fn('CatalogQuantityGatewayCredentialIssuer.issue')(function* issueCredential(input) {
    const response = yield* issue(
      { audience: input.audience, legalEntityId: input.legalEntityId },
      {
        apiKey: configured.apiKey,
        baseUrl: configured.shellBaseUrl,
        requestCorrelation: input.requestCorrelation,
      },
    ).pipe(Effect.mapError((cause) => unavailable('The Catalog gateway credential could not be issued', cause)));
    return { baseUrl: configured.catalogBaseUrl, credential: Redacted.make(`Bearer ${response.token}`) };
  }),
});

export const makeCatalogQuantityGatewayCredentialLayer = (issue: GatewayContextIssue = issueApiKeyGatewayContext) =>
  Layer.effect(
    CatalogQuantityGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: unavailableConfigurationIssuer,
        onSuccess: (configured) => makeCatalogQuantityGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const catalogQuantityGatewayCredentialLive = makeCatalogQuantityGatewayCredentialLayer();
