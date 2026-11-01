import { issueRelayedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { readVerifiedGatewayCompositionRevision, readVerifiedGatewayScopeAssertion } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Config, Crypto, Effect, Layer, Redacted, Schema } from 'effect';

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
  crypto: Crypto.Crypto,
): PriceGroupCatalogGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('PriceGroupCatalogGatewayCredentialIssuer.issue')(
      function* issuePriceGroupCatalogGatewayCredential(input: {
        readonly audience: 'price-group-catalog';
        readonly compositionRevision: string;
        readonly requestCorrelation: string;
        readonly scope: OperationalScope;
      }) {
        const assertion = readVerifiedGatewayScopeAssertion(input.scope);
        const compositionRevision = readVerifiedGatewayCompositionRevision(input.scope);
        if (
          assertion === undefined ||
          assertion.audience !== 'commerce-customer-context' ||
          compositionRevision !== input.compositionRevision ||
          input.scope.legalEntityId === undefined ||
          input.scope.correlationId !== input.requestCorrelation
        ) {
          return yield* unavailable('Verified CCC receiving scope and source Legal Entity are required');
        }
        const exchangeId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
        const response = yield* issueRelayedGatewayContext(
          {
            audience: 'price-group-catalog',
            compositionRevision,
            exchangeId,
            operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
            sourceAssertion: Redacted.value(assertion.assertion),
          },
          {
            apiKey: configured.apiKey,
            baseUrl: configured.baseUrl,
            requestCorrelation: input.requestCorrelation,
          },
        ).pipe(Effect.mapError(unavailable));
        if (response.compositionRevision !== input.compositionRevision) {
          return yield* unavailable('The issued credential does not match the captured composition revision');
        }
        return {
          baseUrl: new URL(response.apiBaseUrl, configured.baseUrl),
          credential: Redacted.make(`Bearer ${response.token}`),
        };
      },
    ),
  });

/**
 * Success-capable production credential Layer. Configuration is deployment-owned and server-only;
 * missing or malformed configuration installs the explicit fail-closed issuer.
 */
export const makePriceGroupCatalogGatewayCredentialLayer = () =>
  Layer.effect(
    PriceGroupCatalogGatewayCredentialService,
    configuration.pipe(
      Effect.matchEffect({
        onFailure: (cause) => Effect.succeed(unavailableConfigurationIssuer(cause)),
        onSuccess: (configured) =>
          Crypto.Crypto.pipe(Effect.map((crypto) => makePriceGroupCatalogGatewayCredentialIssuer(configured, crypto))),
      }),
    ),
  );

export const priceGroupCatalogGatewayCredentialLive = makePriceGroupCatalogGatewayCredentialLayer();
